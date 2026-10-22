#!/usr/bin/env bun
import { mkdirSync, cpSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DISTRIBUTION_OUTPUT_DIRECTORY = 'dist';
const EXTENSION_BUNDLE_DIRECTORY = `${DISTRIBUTION_OUTPUT_DIRECTORY}/clearstt@m-a-d.solutions`;

// Clean
if (existsSync(DISTRIBUTION_OUTPUT_DIRECTORY)) rmSync(DISTRIBUTION_OUTPUT_DIRECTORY, { recursive: true });

// Run tsc
console.log('Compiling TypeScript with tsc...');
const tscResult = Bun.spawnSync(
  ['bun', 'x', 'tsc', '--project', 'tsconfig.json', '--outDir', EXTENSION_BUNDLE_DIRECTORY],
  { stdout: 'inherit', stderr: 'inherit' },
);
if (tscResult.exitCode !== 0) {
  process.exit(tscResult.exitCode ?? 1);
}

// Verify JS output
const expectedFiles = ['extension.js', 'prefs.js'];
for (const expectedJavaScriptFilename of expectedFiles) {
  if (!existsSync(`${EXTENSION_BUNDLE_DIRECTORY}/${expectedJavaScriptFilename}`)) {
    console.error(`ERROR: Expected output file not found: ${expectedJavaScriptFilename}`);
    process.exit(1);
  }
  console.log(
    `  ✓ src/${expectedJavaScriptFilename.replace('.js', '.ts')} → dist/clearstt@m-a-d.solutions/${expectedJavaScriptFilename}`,
  );
}

// Copy static files
console.log('Copying static files...');

// Metadata
cpSync('metadata.json', `${EXTENSION_BUNDLE_DIRECTORY}/metadata.json`);

// Stylesheet
cpSync('stylesheet.css', `${EXTENSION_BUNDLE_DIRECTORY}/stylesheet.css`);

// Schemas
mkdirSync(`${EXTENSION_BUNDLE_DIRECTORY}/schemas`, { recursive: true });
cpSync(
  'schemas/org.gnome.shell.extensions.clearstt.gschema.xml',
  `${EXTENSION_BUNDLE_DIRECTORY}/schemas/org.gnome.shell.extensions.clearstt.gschema.xml`,
);

// Sounds
mkdirSync(`${EXTENSION_BUNDLE_DIRECTORY}/resources`, { recursive: true });
cpSync('resources/start.mp3', `${EXTENSION_BUNDLE_DIRECTORY}/resources/start.mp3`);
cpSync('resources/stop.mp3', `${EXTENSION_BUNDLE_DIRECTORY}/resources/stop.mp3`);

// Locale: compile .po → .mo (must match metadata.json "gettext-domain" + ".mo")
const gettextDomainMoBasename = 'clearstt.mo';
const sourceLocaleRootDirectory = 'locale';
const destinationLocaleRootDirectory = `${EXTENSION_BUNDLE_DIRECTORY}/locale`;
if (existsSync(sourceLocaleRootDirectory)) {
  mkdirSync(destinationLocaleRootDirectory, { recursive: true });
  const localeLanguageDirectoryEntries = readdirSync(sourceLocaleRootDirectory, { withFileTypes: true });
  for (const localeDirectoryEntry of localeLanguageDirectoryEntries) {
    if (!localeDirectoryEntry.isDirectory()) continue;
    const localeLanguageCode = localeDirectoryEntry.name;
    const sourceLcMessagesDirectoryPath = `${sourceLocaleRootDirectory}/${localeLanguageCode}/LC_MESSAGES`;
    if (!existsSync(sourceLcMessagesDirectoryPath)) continue;
    const portableObjectFilenames = readdirSync(sourceLcMessagesDirectoryPath).filter(name =>
      name.endsWith('.po'),
    );
    if (portableObjectFilenames.length === 0) continue;
    portableObjectFilenames.sort();
    if (portableObjectFilenames.length > 1) {
      console.warn(
        `  ! locale/${localeLanguageCode}/LC_MESSAGES: multiple .po files, compiling ${portableObjectFilenames[0]}`,
      );
    }
    const sourcePortableObjectFilePath = `${sourceLcMessagesDirectoryPath}/${portableObjectFilenames[0]}`;
    const destinationLcMessagesDirectoryPath = `${destinationLocaleRootDirectory}/${localeLanguageCode}/LC_MESSAGES`;
    const destinationCompiledMessagesFilePath = `${destinationLcMessagesDirectoryPath}/${gettextDomainMoBasename}`;
    mkdirSync(destinationLcMessagesDirectoryPath, { recursive: true });
    const msgfmtResult = spawnSync(
      'msgfmt',
      [sourcePortableObjectFilePath, '-o', destinationCompiledMessagesFilePath],
      { stdio: 'inherit' },
    );
    if (msgfmtResult.status !== 0) {
      console.error(
        'ERROR: msgfmt failed. Install gettext (e.g. pacman -S gettext) to compile translations.',
      );
      process.exit(msgfmtResult.status ?? 1);
    }
    console.log(`  ✓ locale/${localeLanguageCode}/ → ${gettextDomainMoBasename}`);
  }
}

// Compile GSettings schemas (needed for manual install; `bun run pack` zips this tree with flat paths like GSConnect / Clipboard Indicator)
console.log('Compiling GSettings schemas...');
const compileSchemas = spawnSync('glib-compile-schemas', [`${EXTENSION_BUNDLE_DIRECTORY}/schemas`], {
  stdio: 'inherit',
});
if (compileSchemas.status !== 0) {
  console.error('ERROR: glib-compile-schemas failed. Is glib2 installed?');
  process.exit(compileSchemas.status ?? 1);
}
console.log('  ✓ schemas/gschemas.compiled');

console.log('');
console.log('Build complete! Output in dist/clearstt@m-a-d.solutions/');
console.log('');
console.log('To install:');
console.log('  ln -s "$(pwd)/dist/clearstt@m-a-d.solutions" ~/.local/share/gnome-shell/extensions/clearstt@m-a-d.solutions');
console.log('');
console.log('Then restart GNOME Shell:');
console.log('  • Wayland: log out and log back in');
console.log('  • X11: Alt+F2 → type "r" → Enter');
