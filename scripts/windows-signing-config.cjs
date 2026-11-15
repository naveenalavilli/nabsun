// Configuration only: never creates Azure resources or handles private keys.
function windowsSigningConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing Windows signing setting: ${name}`);
    if (/[\r\n\x00]/.test(value)) throw new Error(`Invalid Windows signing setting: ${name}`);
    return value;
  };
  const endpoint = required('WINDOWS_SIGNING_ENDPOINT');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.codesigning\.azure\.net$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WINDOWS_SIGNING_ENDPOINT must be a regional HTTPS codesigning.azure.net endpoint');
  }
  const account = required('WINDOWS_SIGNING_ACCOUNT');
  const profile = required('WINDOWS_SIGNING_PROFILE');
  if (![account, profile].every(value => /^[a-zA-Z0-9-]+$/.test(value))) {
    throw new Error('Signing account/profile must contain only letters, digits and hyphens');
  }
  return {
    extends: './electron-builder.ci.yml',
    forceCodeSigning: true,
    win: {
      signExecutable: true,
      signAndEditExecutable: true,
      signExts: ['.dll'],
      azureSignOptions: {
        publisherName: required('WINDOWS_SIGNING_PUBLISHER'),
        endpoint, codeSigningAccountName: account, certificateProfileName: profile,
        fileDigest: 'SHA256', timestampDigest: 'SHA256',
        timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      },
    },
  };
}
module.exports = { windowsSigningConfig };
