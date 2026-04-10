// main.bicep — Azure infrastructure for an OpenPalm VM deployment.
//
// Creates: VNet + Subnet + NSG, Storage Account + File Share, VM.
// The VM has no public IP. SSH is via `az ssh vm` (Entra ID).
// Only guardian port 3899 is reachable, and only from within the VNet.

@description('Azure region.')
param location string = resourceGroup().location

@description('Naming prefix for resources.')
param prefix string = 'openpalm'

@description('Storage Account name (globally unique).')
param storageAccountName string

@description('Backup file share name.')
param backupShareName string = 'openpalm-backups'

@description('Backup share quota in GB.')
param backupShareQuota int = 50

@description('Data file share name (mounted on VM at /mnt/openpalm).')
param dataShareName string = 'openpalm'

@description('Data share quota in GB.')
param dataShareQuota int = 100

@description('VNet address space.')
param vnetAddressPrefix string = '10.0.0.0/16'

@description('Subnet CIDR.')
param subnetPrefix string = '10.0.1.0/24'

@description('VM name.')
param vmName string = '${prefix}-vm'

@description('VM admin username.')
param adminUsername string = 'openpalm'

@description('VM size.')
param vmSize string = 'Standard_B1ms'

@description('OS disk size in GB.')
param osDiskSizeGB int = 64

@description('SSH public key. NSG blocks inbound SSH — access is via az ssh vm.')
param sshPublicKey string

@description('Base64-encoded cloud-init custom data.')
param customData string

@description('Key Vault name (globally unique, 3-24 chars).')
param keyVaultName string = 'kv-${prefix}'

// ── Variables ───────────────────────────────────────────────────────────

var vnetName = 'vnet-${prefix}'
var subnetName = 'snet-${prefix}-vm'
var nsgName = 'nsg-${prefix}-vm'

// ── NSG ─────────────────────────────────────────────────────────────────

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowGuardianFromVNet'
        properties: {
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '*'
          sourcePortRange: '*'
          destinationPortRange: '3899'
        }
      }
      {
        name: 'DenyAllInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// ── VNet ────────────────────────────────────────────────────────────────

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: subnetPrefix
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

// ── Storage Account ─────────────────────────────────────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource backupShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: backupShareName
  properties: { shareQuota: backupShareQuota }
}

resource dataShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: dataShareName
  properties: { shareQuota: dataShareQuota }
}

// ── NIC ─────────────────────────────────────────────────────────────────

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: vnet.properties.subnets[0].id }
        }
      }
    ]
  }
}

// ── VM ──────────────────────────────────────────────────────────────────

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: customData
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        managedDisk: { storageAccountType: 'Standard_LRS' }
      }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}

// ── RBAC: VM → Storage (for backup.sh) ──────────────────────────────────

var storageFileContributorRoleId = '69566ab7-960f-475b-8e7c-b3118f30c6bd'

resource storageRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, vm.id, storageFileContributorRoleId)
  scope: storage
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageFileContributorRoleId)
  }
}

// ── Key Vault ──────────────────────────────────────────────────────────

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: false
  }
}

// VM identity → Key Vault Secrets User (read secrets at boot)
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, vm.id, kvSecretsUserRoleId)
  scope: kv
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────

output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmName string = vm.name
output storageAccountName string = storage.name
output dataShareName string = dataShare.name
