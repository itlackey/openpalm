using './ai-foundry.bicep'

param location = 'centralus'
param aiFoundryAccountName = 'ai-openpalm-prod'
param aiFoundrySku = 'S0'

param gpt41DeploymentName = 'gpt-41'
param gpt41Capacity = 10
param gpt41MiniDeploymentName = 'gpt-41-mini'
param gpt41MiniCapacity = 30
param embeddingDeploymentName = 'text-embedding-3-large'
param embeddingDeploymentCapacity = 30

// Must match the Key Vault name used by the main stack.
param keyVaultName = 'openpalmprod-kv-REPLACE'

param enablePrivateEndpoints = true

// Must match the VNet name created by the main stack (vnet-<prefix>).
param vnetName = 'vnet-openpalm-prod'
param peSubnetName = 'snet-pe'
