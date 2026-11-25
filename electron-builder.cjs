// electron-builder configuration (https://www.electron.build/configuration).
// Signing switches on only when the matching secrets are present in the environment, so local
// and fork builds stay unsigned. See docs/SIGNING.md.
const pkg=require('./package.json');
const env=process.env;

// Chromium UI packs to keep (context menus, file dialogs) — the languages kvalah itself supports.
// en-US is Chromium's mandatory fallback. Underscore forms are the macOS .lproj names.
const LOCALES=['en-US','en-GB','ru','uk','de','fr','es','es-419','pt-BR','pt-PT','zh-CN','zh-TW','tr','ja',
  'en','en_GB','es_419','pt_BR','pt_PT','zh_CN','zh_TW'];

// Windows: Azure Trusted Signing signs every PE file (app, uninstaller, installer) during the build.
// SignPath signs after the build in the release workflow (two-stage, see .github/workflows/release.yml).
const azure=env.AZURE_TENANT_ID&&env.AZURE_CLIENT_ID&&env.AZURE_CLIENT_SECRET&&env.AZURE_SIGNING_ENDPOINT&&env.AZURE_SIGNING_ACCOUNT&&env.AZURE_SIGNING_PROFILE;
// Publisher name recorded in app-update.yml; electron-updater then refuses updates signed by anyone else.
// Set it only for signed releases: an unsigned build must not demand a signature.
const publisherName=env.KVALAH_WIN_PUBLISHER?[env.KVALAH_WIN_PUBLISHER]:undefined;
if(azure&&!env.KVALAH_WIN_PUBLISHER)throw Error('Azure signing needs KVALAH_WIN_PUBLISHER = the certificate subject CN (docs/SIGNING.md)');

// macOS: Developer ID certificate (CSC_LINK) + notarization (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID)
// are optional. Without them the app is ad-hoc signed ('-') so it still launches on Apple Silicon.
const macSigned=!!(env.CSC_LINK||env.CSC_NAME);
const notarize=macSigned&&!!(env.APPLE_ID&&env.APPLE_APP_SPECIFIC_PASSWORD&&env.APPLE_TEAM_ID);

module.exports={
  appId:'kvalah.Desktop', // same AppUserModelID as desktop.cjs: keeps taskbar pins and toasts of existing installs
  productName:'kvalah',
  executableName:'kvalah',
  copyright:'Copyright (c) 2026 Enver Abdullaev',
  directories:{output:'release',buildResources:'packaging/electron'},
  // Unpacked app (resources/app): the backend is a separate Node process (ELECTRON_RUN_AS_NODE) that
  // runs from and spawns tools in this folder, which an asar archive cannot provide.
  asar:false,
  npmRebuild:false,
  files:[
    '*.mjs','*.cjs','package.json','LICENSE','public/**/*',
    // Kvalah Compute v0.2 (off by default): Node coordinator/worker + the Python sidecar sources and the
    // CC0 smoke fixture. No Python runtime, no model weights and no test-only scripts are shipped.
    'compute/**/*','!compute/python/tests/**','!**/__pycache__/**','!**/*.pyc',
    '!electron-builder.cjs','!test/**','!scripts/**','!docs/**','!packaging/**',
    // pdf.js: only the Node (legacy) build is used; the optional native canvas is not needed for text.
    '!node_modules/@napi-rs/**',
    '!node_modules/pdfjs-dist/{web,build,image_decoders,types,wasm,iccs}/**',
    '!node_modules/pdfjs-dist/legacy/{web,image_decoders}/**',
    '!**/*.map','!**/*.d.ts','!**/*.d.mts'
  ],
  electronLanguages:LOCALES,
  publish:[{provider:'github',owner:'AranAragan',repo:'kvalah',releaseType:'release'}],
  win:{
    icon:'packaging/electron/icon.ico',
    target:[{target:'nsis',arch:['x64']},{target:'zip',arch:['x64']}],
    artifactName:'kvalah-${version}-win-${arch}-portable.${ext}',
    signtoolOptions:publisherName?{publisherName}:undefined,
    azureSignOptions:azure?{
      publisherName:env.KVALAH_WIN_PUBLISHER,
      endpoint:env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName:env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName:env.AZURE_SIGNING_PROFILE
    }:undefined
  },
  nsis:{
    // Per-user, no UAC, %LOCALAPPDATA%\Programs\kvalah — the same folder the old Setup.exe used,
    // so existing installs are upgraded in place; user data (%APPDATA%\kvalah) is never touched.
    oneClick:true,
    perMachine:false,
    artifactName:'kvalah-${version}-win-${arch}-setup.${ext}',
    shortcutName:'kvalah',
    uninstallDisplayName:'kvalah',
    createDesktopShortcut:'always',
    createStartMenuShortcut:true,
    deleteAppDataOnUninstall:false,
    // Signed installers change after the build (SignPath); full downloads avoid stale blockmaps.
    differentialPackage:false,
    include:'packaging/electron/installer.nsh'
  },
  mac:{
    icon:'packaging/electron/icon.png',
    category:'public.app-category.developer-tools',
    target:[{target:'dmg',arch:['x64','arm64']},{target:'zip',arch:['x64','arm64']}],
    artifactName:'kvalah-${version}-mac-${arch}.${ext}',
    identity:macSigned?undefined:'-',
    hardenedRuntime:macSigned,
    notarize
  },
  dmg:{artifactName:'kvalah-${version}-mac-${arch}.${ext}'},
  linux:{
    icon:'packaging/electron/icon.png',
    category:'Development',
    syncDesktopName:true,
    target:[{target:'AppImage',arch:['x64']},{target:'deb',arch:['x64']}],
    artifactName:'kvalah-${version}-linux-${arch}.${ext}',
    synopsis:'Local coding agent for open models',
    description:pkg.description,
    maintainer:'Enver Abdullaev <AranAragan@users.noreply.github.com>'
  },
  deb:{depends:['libgtk-3-0','libnotify4','libnss3','libxss1','libxtst6','xdg-utils','libatspi2.0-0','libuuid1','libsecret-1-0']},
  extraMetadata:{main:'desktop.cjs'}
};
