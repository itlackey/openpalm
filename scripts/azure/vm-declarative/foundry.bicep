// foundry.bicep — Optional Azure AI Foundry (Cognitive Services) deployment.
//
// Deploys an Azure AI Services account with GPT and embedding model deployments.
// Deployed SEPARATELY from main.bicep to avoid the provisioning race condition
// where the AI account entering "Accepted" state blocks the main deployment.
//
// The API key is stored in the existing Key Vault so first-boot.sh can
// retrieve it alongside the other secrets.

targetScope = 'resourceGroup'

@description('Azure region.')
param location string = resourceGroup().location

@description('Azure AI Services account name (globally unique).')
param foundryAccountName string

@description('SKU for the Azure AI Services account.')
param foundrySku string = 'S0'

@description('Name of the existing Key Vault (created by main.bicep).')
param keyVaultName string

@description('Principal ID of the VM managed identity (for RBAC).')
param vmPrincipalId string

// ── LLM deployment ─────────────────────────────────────────────────────

@description('Deployment name for the primary LLM.')
param llmDeploymentName string = 'gpt-52'

@description('Model name for the primary LLM.')
param llmModelName string = 'gpt-5.2'

@description('Model version for the primary LLM.')
param llmModelVersion string = '2026-01-01'

@description('Capacity (thousands of TPM) for the primary LLM.')
param llmCapacity int = 10

// ── SLM deployment ─────────────────────────────────────────────────────

@description('Deployment name for the small/fast model.')
param slmDeploymentName string = 'gpt-54-mini'

@description('Model name for the small/fast model.')
param slmModelName string = 'gpt-5.4-mini'

@description('Model version for the small/fast model.')
param slmModelVersion string = '2026-01-01'

@description('Capacity (thousands of TPM) for the small/fast model.')
param slmCapacity int = 30

// ── Embedding deployment ───────────────────────────────────────────────

@description('Deployment name for embeddings.')
param embeddingDeploymentName string = 'text-embedding-3-large'

@description('Model name for embeddings.')
param embeddingModelName string = 'text-embedding-3-large'

@description('Model version for embeddings.')
param embeddingModelVersion string = '1'

@description('Capacity (thousands of TPM) for embeddings.')
param embeddingCapacity int = 30

// ── AI Services account ────────────────────────────────────────────────

resource aiFoundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: foundryAccountName
  location: location
  kind: 'AIServices'
  sku: { name: foundrySku }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: foundryAccountName
    disableLocalAuth: false
  }
}

// ── Model deployments (serialized via dependsOn) ───────────────────────

resource llmDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: llmDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: llmCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: llmModelName
      version: llmModelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

resource slmDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: slmDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: slmCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: slmModelName
      version: slmModelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [llmDeployment]
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiFoundry
  name: embeddingDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: embeddingCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: embeddingModelName
      version: embeddingModelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [slmDeployment]
}

// ── Store API key in Key Vault ─────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource apiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-ai-foundry-api-key'
  properties: {
    value: aiFoundry.listKeys().key1
  }
}

// ── RBAC: VM → Cognitive Services OpenAI User ──────────────────────────

var cognitiveServicesOpenAIUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource cognitiveRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiFoundry.id, vmPrincipalId, cognitiveServicesOpenAIUserRoleId)
  scope: aiFoundry
  properties: {
    principalId: vmPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAIUserRoleId)
  }
}

// ── Outputs ────────────────────────────────────────────────────────────

output foundryEndpoint string = aiFoundry.properties.endpoint
output foundryAccountName string = aiFoundry.name
output llmDeployment string = llmDeploymentName
output slmDeployment string = slmDeploymentName
output embeddingDeployment string = embeddingDeploymentName
