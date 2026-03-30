// main.bicep — All Azure infrastructure for an OpenPalm VM deployment.
//
// Creates:
//   - Virtual Network + Subnet
//   - Network Security Group (guardian-only ingress from VNet)
//   - Key Vault (RBAC-enabled, stores secrets)
//   - Storage Account + File Share (backups)
//   - Ubuntu 24.04 LTS VM with system-assigned managed identity
//   - RBAC role assignments (VM → Key Vault, VM → Storage)
//
// Usage:
//   az deployment group create -g <rg> -f main.bicep -p main.bicepparam

// ── Parameters ──────────────────────────────────────────────────────────

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix used in resource names (e.g. "openpalm").')
param prefix string = 'openpalm'

// Key Vault & Storage names must be globally unique.
@description('Key Vault name (globally unique, 3-24 chars, alphanumeric + hyphens).')
param keyVaultName string

@description('Storage Account name (globally unique, 3-24 chars, lowercase alphanumeric).')
param storageAccountName string

@description('Name of the Azure Files share for backups.')
param backupShareName string = 'openpalm-backups'

@description('Backup share quota in GB.')
param backupShareQuota int = 50

// Networking
@description('VNet address space.')
param vnetAddressPrefix string = '10.0.0.0/16'

@description('VM subnet CIDR.')
param subnetPrefix string = '10.0.1.0/24'

// VM
@description('VM name.')
param vmName string = '${prefix}-vm'

@description('VM admin username.')
param adminUsername string = 'openpalm'

@description('VM size.')
param vmSize string = 'Standard_B1ms'

@description('OS disk size in GB.')
param osDiskSizeGB int = 64

@description('VM image publisher.')
param imagePublisher string = 'Canonical'

@description('VM image offer.')
param imageOffer string = 'ubuntu-24_04-lts'

@description('VM image SKU.')
param imageSku string = 'server'

@description('VM image version.')
param imageVersion string = 'latest'

@description('SSH public key for the VM admin user. Required by Azure but the NSG blocks inbound SSH — access is via `az ssh vm` (Entra ID).')
param sshPublicKey string

@description('Base64-encoded cloud-init custom data.')
@secure()
param customData string

@description('Guardian port allowed from VNet.')
param guardianPort int = 3899

// ── Variables ───────────────────────────────────────────────────────────

var vnetName = 'vnet-${prefix}'
var subnetName = 'snet-${prefix}-vm'
var nsgName = 'nsg-${prefix}-vm'

// ── Network Security Group ──────────────────────────────────────────────

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
          destinationPortRange: string(guardianPort)
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

// ── Virtual Network ─────────────────────────────────────────────────────

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: subnetPrefix
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

// ── Key Vault ───────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// ── Storage Account ─────────────────────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource backupShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: backupShareName
  properties: {
    shareQuota: backupShareQuota
  }
}

// ── VM NIC (no public IP) ───────────────────────────────────────────────

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: vnet.properties.subnets[0].id
          }
        }
      }
    ]
  }
}

// ── Virtual Machine ─────────────────────────────────────────────────────

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
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
        publisher: imagePublisher
        offer: imageOffer
        sku: imageSku
        version: imageVersion
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        managedDisk: {
          storageAccountType: 'Standard_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

// ── RBAC: VM identity → Key Vault Secrets User ──────────────────────────

// Built-in role: Key Vault Secrets User
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, vm.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// ── RBAC: VM identity → Storage File Data Privileged Contributor ────────

// Built-in role: Storage File Data Privileged Contributor
var storageFileContributorRoleId = '69566ab7-960f-475b-8e7c-b3118f30c6bd'

resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, vm.id, storageFileContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageFileContributorRoleId)
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────

@description('Private IP address of the VM.')
output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress

@description('VM resource ID.')
output vmResourceId string = vm.id

@description('VM system-assigned identity principal ID.')
output vmPrincipalId string = vm.identity.principalId

@description('Key Vault resource ID.')
output keyVaultId string = keyVault.id

@description('Key Vault URI.')
output keyVaultUri string = keyVault.properties.vaultUri

@description('Storage Account resource ID.')
output storageAccountId string = storageAccount.id

@description('VNet name.')
output vnetName string = vnet.name

@description('Subnet name.')
output subnetName string = vnet.properties.subnets[0].name
