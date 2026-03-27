targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix used in resource names.')
param prefix string = 'openpalm'

@description('Image tag to deploy from Docker Hub.')
param imageTag string = 'latest'

@description('Docker Hub namespace or org for the images.')
param imageNamespace string = 'openpalm'

@description('Address space for the VNet.')
param vnetAddressPrefix string = '10.42.0.0/16'

@description('Dedicated subnet for the ACA environment.')
param acaSubnetPrefix string = '10.42.0.0/23'

@description('Subnet for private endpoints. Not used in this v1 template but reserved now to avoid readdressing later.')
param privateEndpointSubnetPrefix string = '10.42.10.0/24'

@description('Whether the ACA environment should be internal only.')
param internalOnly bool = false

@description('Enable private endpoints and private DNS zones for Key Vault and Storage.')
param enablePrivateEndpoints bool = true

@description('When private endpoints are enabled, disable public network access on Key Vault and Storage.')
param lockDownPublicAccess bool = true

@description('Shared user-assigned identity name used by the apps for Key Vault secret references.')
param identityName string = 'id-openpalm-aca'

@description('Key Vault name. Must be globally unique.')
param keyVaultName string

@description('Storage account name. Must be globally unique and lower-case.')
param storageAccountName string

@description('Key Vault secret versionless URI for OP_MEMORY_TOKEN.')
param memoryTokenSecretUri string

@description('Key Vault secret versionless URI for OP_ASSISTANT_TOKEN.')
param assistantTokenSecretUri string

@description('Key Vault secret versionless URI for OP_ADMIN_TOKEN.')
param adminTokenSecretUri string

@description('Key Vault secret versionless URI for OP_OPENCODE_PASSWORD.')
param opencodePasswordSecretUri string

@description('Key Vault secret versionless URI for CHANNEL_DISCORD_SECRET.')
param channelDiscordSecretUri string = ''

@description('Key Vault secret versionless URI for CHANNEL_SLACK_SECRET.')
param channelSlackSecretUri string = ''

@description('Key Vault secret versionless URI for CHANNEL_API_SECRET.')
param channelApiSecretUri string = ''

@description('Key Vault secret versionless URI for CHANNEL_CHAT_SECRET.')
param channelChatSecretUri string = ''

@description('Key Vault secret versionless URI for CHANNEL_VOICE_SECRET.')
param channelVoiceSecretUri string = ''

@description('Key Vault secret versionless URI for OPENAI_API_KEY. Leave blank if unused.')
param openAiApiKeySecretUri string = ''

@description('Optional non-secret base URL for the OpenAI-compatible provider used by the assistant.')
param openAiBaseUrl string = ''

@description('Capability provider for memory summarization / planning.')
param capLlmProvider string = ''

@description('Capability model for memory summarization / planning.')
param capLlmModel string = ''

@description('Capability base URL for memory summarization / planning.')
param capLlmBaseUrl string = ''

@description('Key Vault secret versionless URI for OP_CAP_LLM_API_KEY. Leave blank if unused.')
param capLlmApiKeySecretUri string = ''

@description('Embedding provider for memory.')
param embeddingsProvider string = ''

@description('Embedding model for memory.')
param embeddingsModel string = ''

@description('Embedding base URL for memory.')
param embeddingsBaseUrl string = ''

@description('Key Vault secret versionless URI for OP_CAP_EMBEDDINGS_API_KEY. Leave blank if unused.')
param embeddingsApiKeySecretUri string = ''

@description('Embedding dimension count used by the memory service.')
param embeddingsDims string = ''

@description('Whether to deploy the scheduled SQLite backup job scaffold. The job image and command are placeholders until you add the backup image or script.')
param deployBackupJob bool = false

var suffix = toLower(uniqueString(subscription().id, resourceGroup().id, prefix))
var managedEnvironmentName = 'acae-${prefix}'
var logAnalyticsName = 'log-${prefix}'
var vnetName = 'vnet-${prefix}'
var acaSubnetName = 'snet-aca'
var peSubnetName = 'snet-pe'
var privateDnsZones = {
  keyVault: 'privatelink.vaultcore.azure.net'
  file: 'privatelink.file.core.windows.net'
  blob: 'privatelink.blob.core.windows.net'
}
var appNames = {
  memory: 'op-memory'
  assistant: 'op-assistant'
  guardian: 'op-guardian'
  scheduler: 'op-scheduler'
  backupJob: 'op-memory-backup'
}

var storageShares = {
  assistantHome: 'assistant-home'
  assistantConfig: 'assistant-config'
  vaultUser: 'vault-user'
  stash: 'stash'
  workspace: 'workspace'
  logs: 'logs'
  config: 'config'
  data: 'data'
  memoryData: 'memory-data'
  guardianData: 'guardian-data'
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: acaSubnetName
        properties: {
          addressPrefix: acaSubnetPrefix
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: peSubnetName
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      searchVersion: 1
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    accessTier: 'Hot'
    publicNetworkAccess: enablePrivateEndpoints && lockDownPublicAccess ? 'Disabled' : 'Enabled'
  }
}

resource shareAssistantHome 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.assistantHome}'
}

resource shareAssistantConfig 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.assistantConfig}'
}

resource shareVaultUser 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.vaultUser}'
}

resource shareStash 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.stash}'
}

resource shareWorkspace 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.workspace}'
}

resource shareLogs 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.logs}'
}

resource shareConfig 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.config}'
}

resource shareData 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.data}'
}

resource shareMemoryData 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.memoryData}'
}

resource shareGuardianData 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  name: '${storage.name}/default/${storageShares.guardianData}'
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    publicNetworkAccess: enablePrivateEndpoints && lockDownPublicAccess ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: enablePrivateEndpoints && lockDownPublicAccess ? 'Deny' : 'Allow'
      bypass: enablePrivateEndpoints && lockDownPublicAccess ? 'None' : 'AzureServices'
    }
  }
}

resource kvPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoints) {
  name: privateDnsZones.keyVault
  location: 'global'
}

resource filePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoints) {
  name: privateDnsZones.file
  location: 'global'
}

resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoints) {
  name: privateDnsZones.blob
  location: 'global'
}

resource kvDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoints) {
  parent: kvPrivateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource fileDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoints) {
  parent: filePrivateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoints) {
  parent: blobPrivateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (enablePrivateEndpoints) {
  name: 'pe-${keyVaultName}'
  location: location
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, peSubnetName)
    }
    privateLinkServiceConnections: [
      {
        name: 'keyvault'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource keyVaultPrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (enablePrivateEndpoints) {
  parent: keyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'keyvault'
        properties: {
          privateDnsZoneId: kvPrivateDnsZone.id
        }
      }
    ]
  }
}

resource storageFilePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (enablePrivateEndpoints) {
  name: 'pe-${storage.name}-file'
  location: location
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, peSubnetName)
    }
    privateLinkServiceConnections: [
      {
        name: 'file'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'file'
          ]
        }
      }
    ]
  }
}

resource storageFilePrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (enablePrivateEndpoints) {
  parent: storageFilePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'file'
        properties: {
          privateDnsZoneId: filePrivateDnsZone.id
        }
      }
    ]
  }
}

resource storageBlobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (enablePrivateEndpoints) {
  name: 'pe-${storage.name}-blob'
  location: location
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, peSubnetName)
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storageBlobPrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (enablePrivateEndpoints) {
  parent: storageBlobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZone.id
        }
      }
    ]
  }
}

resource sharedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource keyVaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, sharedIdentity.id, 'KeyVaultSecretsUser')
  scope: keyVault
  properties: {
    principalId: sharedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: managedEnvironmentName
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, acaSubnetName)
      internal: internalOnly
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, logAnalytics.apiVersion).primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource envStorageAssistantHome 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.assistantHome
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.assistantHome
    }
  }
}

resource envStorageAssistantConfig 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.assistantConfig
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.assistantConfig
    }
  }
}

resource envStorageVaultUser 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.vaultUser
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.vaultUser
    }
  }
}

resource envStorageStash 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.stash
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.stash
    }
  }
}

resource envStorageWorkspace 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.workspace
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.workspace
    }
  }
}

resource envStorageLogs 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.logs
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.logs
    }
  }
}

resource envStorageConfig 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.config
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.config
    }
  }
}

resource envStorageData 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.data
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.data
    }
  }
}

resource envStorageMemoryData 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.memoryData
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.memoryData
    }
  }
}

resource envStorageGuardianData 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: managedEnvironment
  name: storageShares.guardianData
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      accountName: storage.name
      shareName: storageShares.guardianData
    }
  }
}

var assistantSecrets = concat(
  [
    {
      name: 'memory-token'
      keyVaultUrl: memoryTokenSecretUri
      identity: sharedIdentity.id
    }
    {
      name: 'assistant-token'
      keyVaultUrl: assistantTokenSecretUri
      identity: sharedIdentity.id
    }
  ],
  empty(openAiApiKeySecretUri) ? [] : [
    {
      name: 'openai-api-key'
      keyVaultUrl: openAiApiKeySecretUri
      identity: sharedIdentity.id
    }
  ]
)

var memorySecrets = concat(
  [
    {
      name: 'memory-token'
      keyVaultUrl: memoryTokenSecretUri
      identity: sharedIdentity.id
    }
  ],
  empty(capLlmApiKeySecretUri) ? [] : [
    {
      name: 'cap-llm-api-key'
      keyVaultUrl: capLlmApiKeySecretUri
      identity: sharedIdentity.id
    }
  ],
  empty(embeddingsApiKeySecretUri) ? [] : [
    {
      name: 'embeddings-api-key'
      keyVaultUrl: embeddingsApiKeySecretUri
      identity: sharedIdentity.id
    }
  ]
)

var guardianSecrets = concat(
  empty(channelDiscordSecretUri) ? [] : [{ name: 'channel-discord-secret', keyVaultUrl: channelDiscordSecretUri, identity: sharedIdentity.id }],
  empty(channelSlackSecretUri) ? [] : [{ name: 'channel-slack-secret', keyVaultUrl: channelSlackSecretUri, identity: sharedIdentity.id }],
  empty(channelApiSecretUri) ? [] : [{ name: 'channel-api-secret', keyVaultUrl: channelApiSecretUri, identity: sharedIdentity.id }],
  empty(channelChatSecretUri) ? [] : [{ name: 'channel-chat-secret', keyVaultUrl: channelChatSecretUri, identity: sharedIdentity.id }],
  empty(channelVoiceSecretUri) ? [] : [{ name: 'channel-voice-secret', keyVaultUrl: channelVoiceSecretUri, identity: sharedIdentity.id }]
)

resource memoryApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appNames.memory
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8765
        transport: 'auto'
        allowInsecure: true
      }
      secrets: memorySecrets
    }
    template: {
      volumes: [
        { name: 'memory-data', storageType: 'EmptyDir' }
        { name: 'memory-config', storageType: 'EmptyDir' }
      ]
      initContainers: [
        {
          name: 'seed-memory-config'
          image: 'docker.io/${imageNamespace}/memory:${imageTag}'
          command: ['/bin/sh', '-c']
          args: ['mkdir -p /etc/memory && printf \'{"llm":{"provider":"%s","config":{"model":"%s","apiKey":"%s","baseUrl":"%s"}},"embedder":{"provider":"%s","config":{"model":"%s","apiKey":"%s","baseUrl":"%s","dimensions":%s}},"vectorStore":{"provider":"sqlite-vec","config":{"collectionName":"memory","dbPath":"/data/memory.db","dimensions":%s}}}\' "$SYSTEM_LLM_PROVIDER" "$SYSTEM_LLM_MODEL" "$SYSTEM_LLM_API_KEY" "$SYSTEM_LLM_BASE_URL" "$EMBEDDING_PROVIDER" "$EMBEDDING_MODEL" "$EMBEDDING_API_KEY" "$EMBEDDING_BASE_URL" "$EMBEDDING_DIMS" "$EMBEDDING_DIMS" > /etc/memory/memory.conf.json && echo "Config seeded"']
          env: concat(
            [
              { name: 'SYSTEM_LLM_PROVIDER', value: capLlmProvider }
              { name: 'SYSTEM_LLM_MODEL', value: capLlmModel }
              { name: 'SYSTEM_LLM_BASE_URL', value: capLlmBaseUrl }
              { name: 'EMBEDDING_PROVIDER', value: embeddingsProvider }
              { name: 'EMBEDDING_MODEL', value: embeddingsModel }
              { name: 'EMBEDDING_BASE_URL', value: embeddingsBaseUrl }
              { name: 'EMBEDDING_DIMS', value: embeddingsDims }
            ],
            empty(capLlmApiKeySecretUri) ? [] : [{ name: 'SYSTEM_LLM_API_KEY', secretRef: 'cap-llm-api-key' }],
            empty(embeddingsApiKeySecretUri) ? [] : [{ name: 'EMBEDDING_API_KEY', secretRef: 'embeddings-api-key' }]
          )
          volumeMounts: [
            { volumeName: 'memory-config', mountPath: '/etc/memory' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      containers: [
        {
          name: 'memory'
          image: 'docker.io/${imageNamespace}/memory:${imageTag}'
          env: concat(
            [
              { name: 'MEMORY_DATA_DIR', value: '/data' }
              { name: 'MEMORY_CONFIG_PATH', value: '/etc/memory/memory.conf.json' }
              { name: 'HOME', value: '/data' }
              { name: 'MEMORY_AUTH_TOKEN', secretRef: 'memory-token' }
              { name: 'MEMORY_USER_ID', value: 'default_user' }
              { name: 'SYSTEM_LLM_PROVIDER', value: capLlmProvider }
              { name: 'SYSTEM_LLM_MODEL', value: capLlmModel }
              { name: 'SYSTEM_LLM_BASE_URL', value: capLlmBaseUrl }
              { name: 'EMBEDDING_PROVIDER', value: embeddingsProvider }
              { name: 'EMBEDDING_MODEL', value: embeddingsModel }
              { name: 'EMBEDDING_BASE_URL', value: embeddingsBaseUrl }
              { name: 'EMBEDDING_DIMS', value: embeddingsDims }
            ],
            empty(capLlmApiKeySecretUri) ? [] : [{ name: 'SYSTEM_LLM_API_KEY', secretRef: 'cap-llm-api-key' }],
            empty(embeddingsApiKeySecretUri) ? [] : [{ name: 'EMBEDDING_API_KEY', secretRef: 'embeddings-api-key' }]
          )
          volumeMounts: [
            { volumeName: 'memory-data', mountPath: '/data' }
            { volumeName: 'memory-config', mountPath: '/etc/memory' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8765
              }
              initialDelaySeconds: 10
              periodSeconds: 15
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    envStorageMemoryData
    keyVaultSecretsUserRole
  ]
}

resource assistantApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appNames.assistant
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 4096
        transport: 'auto'
        allowInsecure: true
      }
      secrets: assistantSecrets
    }
    template: {
      volumes: [
        { name: 'assistant-home', storageType: 'EmptyDir' }
        { name: 'assistant-config', storageType: 'AzureFile', storageName: storageShares.assistantConfig }
        { name: 'vault-user', storageType: 'AzureFile', storageName: storageShares.vaultUser }
        { name: 'stash', storageType: 'AzureFile', storageName: storageShares.stash }
        { name: 'workspace', storageType: 'AzureFile', storageName: storageShares.workspace }
        { name: 'logs', storageType: 'AzureFile', storageName: storageShares.logs }
      ]
      initContainers: [
        {
          name: 'seed-config'
          image: 'docker.io/${imageNamespace}/assistant:${imageTag}'
          command: ['/bin/bash', '-c']
          args: ['if [ ! -f /home/opencode/.config/opencode/opencode.json ]; then echo \'{"plugin":["@openpalm/assistant-tools","akm-opencode@0.2.0","opencode-varlock@0.0.10"]}\' > /home/opencode/.config/opencode/opencode.json; echo "Seeded user config with plugin declarations"; else echo "User config already exists, skipping"; fi']
          volumeMounts: [
            { volumeName: 'assistant-config', mountPath: '/home/opencode/.config/opencode' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      containers: [
        {
          name: 'assistant'
          image: 'docker.io/${imageNamespace}/assistant:${imageTag}'
          env: concat(
            [
              { name: 'OPENCODE_CONFIG_DIR', value: '/etc/opencode' }
              { name: 'OPENCODE_PORT', value: '4096' }
              { name: 'OPENCODE_AUTH', value: 'false' }
              { name: 'OPENCODE_ENABLE_SSH', value: '0' }
              { name: 'TERM', value: 'xterm-256color' }
              { name: 'HOME', value: '/home/opencode' }
              { name: 'AKM_STASH_DIR', value: '/home/opencode/.akm' }
              { name: 'OP_ADMIN_API_URL', value: '' }
              { name: 'OP_ASSISTANT_TOKEN', secretRef: 'assistant-token' }
              { name: 'MEMORY_API_URL', value: 'http://${appNames.memory}' }
              { name: 'MEMORY_AUTH_TOKEN', secretRef: 'memory-token' }
              { name: 'MEMORY_USER_ID', value: 'default_user' }
              { name: 'OP_UID', value: '1000' }
              { name: 'OP_GID', value: '1000' }
              { name: 'OPENAI_BASE_URL', value: openAiBaseUrl }
              { name: 'SYSTEM_LLM_PROVIDER', value: capLlmProvider }
            ],
            empty(openAiApiKeySecretUri) ? [] : [{ name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }]
          )
          volumeMounts: [
            { volumeName: 'assistant-home', mountPath: '/home/opencode' }
            { volumeName: 'assistant-config', mountPath: '/home/opencode/.config/opencode' }
            { volumeName: 'vault-user', mountPath: '/etc/vault' }
            { volumeName: 'stash', mountPath: '/home/opencode/.akm' }
            { volumeName: 'workspace', mountPath: '/work' }
            { volumeName: 'logs', mountPath: '/home/opencode/.local/state/opencode' }
          ]
          resources: {
            cpu: 2
            memory: '4Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 4096
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    envStorageAssistantHome
    envStorageAssistantConfig
    envStorageVaultUser
    envStorageStash
    envStorageWorkspace
    envStorageLogs
    keyVaultSecretsUserRole
    memoryApp
  ]
}

resource guardianApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appNames.guardian
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8080
        transport: 'auto'
        allowInsecure: true
      }
      secrets: guardianSecrets
    }
    template: {
      volumes: [
        { name: 'guardian-data', storageType: 'AzureFile', storageName: storageShares.guardianData }
        { name: 'logs', storageType: 'AzureFile', storageName: storageShares.logs }
      ]
      containers: [
        {
          name: 'guardian'
          image: 'docker.io/${imageNamespace}/guardian:${imageTag}'
          env: concat(
            [
              { name: 'HOME', value: '/app/data' }
              { name: 'PORT', value: '8080' }
              { name: 'OP_ASSISTANT_URL', value: 'http://${appNames.assistant}' }
              { name: 'OPENCODE_TIMEOUT_MS', value: '0' }
              { name: 'GUARDIAN_AUDIT_PATH', value: '/app/audit/guardian-audit.log' }
            ],
            empty(channelDiscordSecretUri) ? [] : [{ name: 'CHANNEL_DISCORD_SECRET', secretRef: 'channel-discord-secret' }],
            empty(channelSlackSecretUri) ? [] : [{ name: 'CHANNEL_SLACK_SECRET', secretRef: 'channel-slack-secret' }],
            empty(channelApiSecretUri) ? [] : [{ name: 'CHANNEL_API_SECRET', secretRef: 'channel-api-secret' }],
            empty(channelChatSecretUri) ? [] : [{ name: 'CHANNEL_CHAT_SECRET', secretRef: 'channel-chat-secret' }],
            empty(channelVoiceSecretUri) ? [] : [{ name: 'CHANNEL_VOICE_SECRET', secretRef: 'channel-voice-secret' }]
          )
          volumeMounts: [
            { volumeName: 'guardian-data', mountPath: '/app/data' }
            { volumeName: 'logs', mountPath: '/app/audit' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    envStorageGuardianData
    envStorageLogs
    keyVaultSecretsUserRole
    assistantApp
  ]
}

resource schedulerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appNames.scheduler
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8090
        transport: 'auto'
        allowInsecure: true
      }
      secrets: [
        {
          name: 'memory-token'
          keyVaultUrl: memoryTokenSecretUri
          identity: sharedIdentity.id
        }
        {
          name: 'admin-token'
          keyVaultUrl: adminTokenSecretUri
          identity: sharedIdentity.id
        }
        {
          name: 'opencode-password'
          keyVaultUrl: opencodePasswordSecretUri
          identity: sharedIdentity.id
        }
      ]
    }
    template: {
      volumes: [
        { name: 'config', storageType: 'AzureFile', storageName: storageShares.config }
        { name: 'logs', storageType: 'AzureFile', storageName: storageShares.logs }
        { name: 'data', storageType: 'AzureFile', storageName: storageShares.data }
      ]
      containers: [
        {
          name: 'scheduler'
          image: 'docker.io/${imageNamespace}/scheduler:${imageTag}'
          env: [
            { name: 'PORT', value: '8090' }
            { name: 'OP_HOME', value: '/openpalm' }
            { name: 'OP_ADMIN_TOKEN', secretRef: 'admin-token' }
            { name: 'OP_ADMIN_API_URL', value: '' }
            { name: 'OPENCODE_API_URL', value: 'http://${appNames.assistant}' }
            { name: 'OPENCODE_SERVER_PASSWORD', secretRef: 'opencode-password' }
            { name: 'MEMORY_API_URL', value: 'http://${appNames.memory}' }
            { name: 'MEMORY_AUTH_TOKEN', secretRef: 'memory-token' }
            { name: 'MEMORY_USER_ID', value: 'default_user' }
          ]
          volumeMounts: [
            { volumeName: 'config', mountPath: '/openpalm/config' }
            { volumeName: 'logs', mountPath: '/openpalm/logs' }
            { volumeName: 'data', mountPath: '/openpalm/data' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8090
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    envStorageConfig
    envStorageLogs
    envStorageData
    keyVaultSecretsUserRole
    assistantApp
    memoryApp
  ]
}

resource backupJob 'Microsoft.App/jobs@2025-01-01' = if (deployBackupJob) {
  name: appNames.backupJob
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharedIdentity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '0 3 * * *'
      }
      replicaRetryLimit: 1
      replicaTimeout: 1800
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'backup'
          image: 'alpine:3'
          command: [
            '/bin/sh'
          ]
          args: [
            '-c'
            'echo "Replace this placeholder with your sqlite-to-blob backup script or custom image." && exit 0'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output managedEnvironmentId string = managedEnvironment.id
output keyVaultUri string = keyVault.properties.vaultUri
output sharedIdentityId string = sharedIdentity.id
output storageAccountResourceId string = storage.id
output appNames object = appNames
output privateDnsZoneNames object = privateDnsZones
output keyVaultPrivateEndpointId string = enablePrivateEndpoints ? keyVaultPrivateEndpoint.id : ''
output storageFilePrivateEndpointId string = enablePrivateEndpoints ? storageFilePrivateEndpoint.id : ''
output storageBlobPrivateEndpointId string = enablePrivateEndpoints ? storageBlobPrivateEndpoint.id : ''
