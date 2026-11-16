const fs = require('node:fs');
const path = require('node:path');
function installerNotice(root) {
  return '\uFEFFNabsun - license and privacy information\r\n\r\n' +
    ['LICENSE', 'PRIVACY.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\r?\n/g, '\r\n')).join('\r\n\r\n--------------------\r\n\r\n');
}
function writeInstallerNotice(root) {
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'installer-notice.txt'), installerNotice(root), 'utf8');
}
module.exports = { installerNotice, writeInstallerNotice };
