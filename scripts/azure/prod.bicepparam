using './main.bicep'

param location = 'centralus'
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
param channelSlackSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/channel-slack-secret'
param slackBotTokenSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/slack-bot-token'
param slackAppTokenSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/slack-app-token'
param channelApiSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/channel-api-secret'
param channelChatSecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/channel-chat-secret'
param channelVoiceSecretUri = ''

// Memory capability / embedding configuration.
// AI Foundry serves memory summarization and embeddings ONLY — not the assistant.
// The assistant uses OpenCode's default built-in provider (no OPENAI_* env vars).
// When aiFoundryApiKeySecretUri is set, capLlmApiKeySecretUri and embeddingsApiKeySecretUri
// can be left blank — the template will fall back to the AI Foundry key automatically.
param capLlmProvider = 'azure_openai'
// When using azure_openai provider, this must be the DEPLOYMENT NAME (not model name).
param capLlmModel = 'gpt-41-mini'
param capLlmBaseUrl = 'https://ai-openpalm-prod.openai.azure.com/'
param capLlmApiKeySecretUri = ''

param embeddingsProvider = 'azure_openai'
param embeddingsModel = 'text-embedding-3-large'
param embeddingsBaseUrl = 'https://ai-openpalm-prod.openai.azure.com/'
param embeddingsApiKeySecretUri = ''
param embeddingsDims = '3072'

param deployBackupJob = false

// AI Foundry is deployed separately via ai-foundry.bicep to avoid the provisioning race
// condition (LESSONS-LEARNED.md #3). Pass the Key Vault secret URI produced by that deployment.
param aiFoundryApiKeySecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/azure-ai-foundry-api-key'

// OpenViking — knowledge management and semantic search.
// Uses the same embedding config as memory (AI Foundry text-embedding-3-large).
param deployOpenViking = true
param openVikingApiKeySecretUri = 'https://openpalmprod-kv-REPLACE.vault.azure.net/secrets/openviking-api-key'

param enablePrivateEndpoints = true
param lockDownPublicAccess = true
