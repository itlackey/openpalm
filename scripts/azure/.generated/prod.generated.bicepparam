using '../main.bicep'

param location = 'eastus2'
param prefix = 'openpalm-prod'
param imageTag = 'latest'
param imageNamespace = 'openpalm'

// Must be globally unique.
param keyVaultName = 'openpalmkvd90fb6e9'
param storageAccountName = 'openpalmst07884371'

// These versionless URIs are written by deploy.ts after it creates or updates Key Vault secrets.
param memoryTokenSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-memory-token'
param assistantTokenSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-assistant-token'
param adminTokenSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-admin-token'
param opencodePasswordSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-opencode-password'

// Guardian channel secrets. Leave blank if the channel is not enabled yet.
param channelDiscordSecretUri = ''
param channelSlackSecretUri = ''
param channelApiSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/channel-api-secret'
param channelChatSecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/channel-chat-secret'
param channelVoiceSecretUri = ''

// Assistant provider wiring.
param openAiApiKeySecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/openai-api-key'
param openAiBaseUrl = 'https://api.openai.com/v1'

// Memory capability / embedding configuration.
param capLlmProvider = 'openai'
param capLlmModel = 'gpt-4.1-mini'
param capLlmBaseUrl = 'https://api.openai.com/v1'
param capLlmApiKeySecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-cap-llm-api-key'

param embeddingsProvider = 'openai'
param embeddingsModel = 'text-embedding-3-large'
param embeddingsBaseUrl = 'https://api.openai.com/v1'
param embeddingsApiKeySecretUri = 'https://openpalmkvd90fb6e9.vault.azure.net/secrets/op-cap-embeddings-api-key'
param embeddingsDims = '3072'

param deployBackupJob = false

param enablePrivateEndpoints = true
param lockDownPublicAccess = true
