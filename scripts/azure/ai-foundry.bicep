// ---------------------------------------------------------------------------
// Azure AI Foundry — standalone Cognitive Services account + GPT model deployments
//
// Deploy INDEPENDENTLY from the main stack to avoid the provisioning race
// condition where the AI Foundry account entering "Accepted" state blocks
// the main Bicep deployment. See LESSONS-LEARNED.md #3.
//
// Usage:
//   az deployment group create -g <rg> -f ai-foundry.bicep -p ai-foundry.bicepparam
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Azure region for the AI Foundry account.')
param location string = resourceGroup().location

@description('Name for the Azure AI Services account. Must be globally unique.')
param aiFoundryAccountName string

@description('SKU for the Azure AI Services account.')
param aiFoundrySku string = 'S0'

@description('Deployment name for the GPT 4.1 model.')
param gpt41DeploymentName string = 'gpt-41'

@description('Capacity (in thousands of tokens-per-minute) for the GPT 4.1 deployment.')
param gpt41Capacity int = 10

@description('Deployment name for the GPT 4.1 Mini model.')
param gpt41MiniDeploymentName string = 'gpt-41-mini'

@description('Capacity (in thousands of tokens-per-minute) for the GPT 4.1 Mini deployment.')
param gpt41MiniCapacity int = 30

@description('Deployment name for the text-embedding-3-large model.')
param embeddingDeploymentName string = 'text-embedding-3-large'

@description('Capacity (in thousands of tokens-per-minute) for the embedding deployment.')
param embeddingDeploymentCapacity int = 30

@description('Name of an existing Key Vault to store the AI Foundry API key.')
param keyVaultName string

@description('Enable private endpoint + DNS zone for the AI Foundry account.')
param enablePrivateEndpoints bool = true

@description('Name of the existing VNet to attach the private endpoint to.')
param vnetName string

@description('Name of the private endpoint subnet within the VNet.')
param peSubnetName string = 'snet-pe'

// ---------------------------------------------------------------------------
// Cognitive Services account
// ---------------------------------------------------------------------------

resource aiFoundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aiFoundryAccountName
  location: location
  kind: 'AIServices'
  sku: {
    name: aiFoundrySku
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: aiFoundryAccountName
    // Do NOT toggle publicNetworkAccess — changing it puts the account into
    // 'Accepted' state for 30-60s, which causes subsequent deployments to fail
    // with AccountProvisioningStateInvalid. The private endpoint provides
    // network security. See LESSONS-LEARNED.md #3.
    disableLocalAuth: false
  }
}

// ---------------------------------------------------------------------------
// Model deployments (GlobalStandard SKU, serialized via dependsOn)
// ---------------------------------------------------------------------------

resource gpt41Deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: gpt41DeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: gpt41Capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4.1'
      version: '2025-04-14'
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

resource gpt41MiniDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: gpt41MiniDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: gpt41MiniCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4.1-mini'
      version: '2025-04-14'
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [
    gpt41Deployment
  ]
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: embeddingDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: embeddingDeploymentCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-large'
      version: '1'
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [
    gpt41MiniDeployment
  ]
}

// ---------------------------------------------------------------------------
// Store API key in the existing Key Vault
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource aiFoundryApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-ai-foundry-api-key'
  properties: {
    value: aiFoundry.listKeys().key1
  }
}

// ---------------------------------------------------------------------------
// Private endpoint + DNS zone (optional)
// ---------------------------------------------------------------------------

var privateDnsZoneName = 'privatelink.cognitiveservices.azure.com'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource cognitiveServicesPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoints) {
  name: privateDnsZoneName
  location: 'global'
}

resource cognitiveServicesDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoints) {
  parent: cognitiveServicesPrivateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource aiFoundryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (enablePrivateEndpoints) {
  name: 'pe-${aiFoundryAccountName}'
  location: location
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, peSubnetName)
    }
    privateLinkServiceConnections: [
      {
        name: 'cognitiveservices'
        properties: {
          privateLinkServiceId: aiFoundry.id
          groupIds: [
            'account'
          ]
        }
      }
    ]
  }
}

resource aiFoundryPrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (enablePrivateEndpoints) {
  parent: aiFoundryPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'cognitiveservices'
        properties: {
          privateDnsZoneId: cognitiveServicesPrivateDnsZone.id
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output aiFoundryEndpoint string = aiFoundry.properties.endpoint
output aiFoundryAccountName string = aiFoundry.name
output aiFoundryApiKeySecretUri string = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/azure-ai-foundry-api-key'
output modelDeployments array = [gpt41DeploymentName, gpt41MiniDeploymentName, embeddingDeploymentName]
