#!/usr/bin/env node
// Patches for breezeconnect SDK bugs:
// 1. getOptionChainQuotes validation: || should be && (a string can't be both "nfo" AND "bfo")
// 2. makeRequest: `let url` inside try block is not accessible in catch block

const fs = require('fs');
const path = require('path');

const sdkPath = path.join(__dirname, '..', 'node_modules', 'breezeconnect', 'breezeConnect.js');

try {
  let content = fs.readFileSync(sdkPath, 'utf-8');
  let patched = false;

  // Patch 1: Fix validation logic || → &&
  const buggy = 'exchangeCode.toLowerCase()!=="nfo" || exchangeCode.toLowerCase()!=="bfo"';
  const fixed = 'exchangeCode.toLowerCase()!=="nfo" && exchangeCode.toLowerCase()!=="bfo"';
  if (content.includes(buggy)) {
    content = content.replace(buggy, fixed);
    console.log('[patch] Fixed breezeconnect SDK validation: || → &&');
    patched = true;
  }

  // Patch 2: Fix url scoping in makeRequest — move `let url` before try block
  const makeRequestBuggy = `self.makeRequest = async function(method, endpoint, body, header) {\n        try {\n\n            let url = urls.API_URL + endpoint;`;
  const makeRequestFixed = `self.makeRequest = async function(method, endpoint, body, header) {\n        let url = '';\n        try {\n\n            url = urls.API_URL + endpoint;`;
  if (content.includes(makeRequestBuggy)) {
    content = content.replace(makeRequestBuggy, makeRequestFixed);
    console.log('[patch] Fixed makeRequest url scoping: moved url declaration before try');
    patched = true;
  }

  if (patched) {
    fs.writeFileSync(sdkPath, content);
    console.log('[patch] breezeconnect SDK patches applied');
  } else {
    console.log('[patch] breezeconnect SDK already patched or pattern not found');
  }
} catch (e) {
  // SDK not installed yet, postinstall will run again after bun install
}
