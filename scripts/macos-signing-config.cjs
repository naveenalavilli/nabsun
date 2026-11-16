function macSigningConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value || /[\r\n\x00]/.test(value)) throw Error(`Missing or invalid macOS signing setting: ${name}`);
    return value;
  };
  const team = required('APPLE_TEAM_ID');
  const identity = required('MAC_SIGNING_IDENTITY');
  if (!/^[A-Z0-9]{10}$/.test(team) || !identity.startsWith('Developer ID Application: ') || !identity.endsWith(` (${team})`)) {
    throw Error('Expected a Developer ID Application identity matching APPLE_TEAM_ID');
  }
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) required(name);
  return { extends: './electron-builder.ci.yml', forceCodeSigning: true,
    // electron-builder chooses the certificate class itself and rejects its prefix.
    mac: { identity: identity.slice('Developer ID Application: '.length), hardenedRuntime: true, notarize: true } };
}
module.exports = { macSigningConfig };
