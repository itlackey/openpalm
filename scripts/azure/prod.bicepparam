using './main.bicep'

param location = 'eastus2'
param prefix = 'openpalm-prod'
param imageTag = 'latest'
param imageNamespace = 'openpalm'

// Must be globally unique.
param keyVaultName = 'openpalmprod-kv-REPLACE'
param storageAccountName = 'openpalmprodstREPL'

// These versionless URIs are written by deploy.ts after it creates or updates Key Vault secrets.
param memoryTokenSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/op-memory-token'
param assistantTokenSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/op-assistant-token'
param adminTokenSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/op-admin-token'
param opencodePasswordSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/op-opencode-password'

// Guardian channel secrets. Leave blank if the channel is not enabled yet.
param channelDiscordSecretUri = ''
param channelSlackSecretUri = ''
param channelApiSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/channel-api-secret'
param channelChatSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/channel-chat-secret'
param channelVoiceSecretUri = ''

// Assistant provider wiring.
param openAiApiKeySecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/openai-api-key'
param openAiBaseUrl = 'https://api.openai.com/v1'

// Memory capability / embedding configuration.
// When deployAiFoundry is true, capLlmApiKeySecretUri and embeddingsApiKeySecretUri
// can be left blank — the template will fall back to the AI Foundry key automatically.
param capLlmProvider = 'openai'
param capLlmModel = 'gpt-54-mini'
param capLlmBaseUrl = 'https://ai-openpalm-prod.openai.azure.com/'
param capLlmApiKeySecretUri = ''

param embeddingsProvider = 'openai'
param embeddingsModel = 'text-embedding-3-large'
param embeddingsBaseUrl = 'https://ai-openpalm-prod.openai.azure.com/'
param embeddingsApiKeySecretUri = ''
param embeddingsDims = '3072'

param deployBackupJob = false

// Azure AI Foundry – deploys an AI Services account with GPT 5.4 and GPT 5.4 Mini.
// When enabled, the assistant container's OPENAI_BASE_URL and OPENAI_API_KEY are
// automatically wired to the Foundry endpoint and Key Vault secret.
param deployAiFoundry = true
param aiFoundryAccountName = 'ai-openpalm-prod'
param aiFoundrySku = 'S0'
param gpt54DeploymentName = 'gpt-54'
param gpt54Capacity = 10
param gpt54MiniDeploymentName = 'gpt-54-mini'
param gpt54MiniCapacity = 30

param enablePrivateEndpoints = true
param lockDownPublicAccess = true
