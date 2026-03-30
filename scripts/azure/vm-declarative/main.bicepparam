using './main.bicep'

param storageAccountName = 'stopenpalm'
param sshPublicKey = '__SSH_PUBLIC_KEY__'
param customData = '__CUSTOM_DATA__'
param keyVaultName = '__KEY_VAULT_NAME__'

// Override any defaults here:
// param prefix = 'openpalm'
// param vmSize = 'Standard_B1ms'
// param osDiskSizeGB = 64
// param adminUsername = 'openpalm'
// param backupShareName = 'openpalm-backups'
// param vnetAddressPrefix = '10.0.0.0/16'
// param subnetPrefix = '10.0.1.0/24'
