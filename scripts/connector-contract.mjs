#!/usr/bin/env node
/* global process, console */
/** Safe local connector contract. Runs only on a trusted worker host.
 * It never belongs in the browser bundle and never stores bearer tokens.
 */
const endpoint=process.env.GLASSBOARD_CONNECTOR_ENDPOINT;
const connector=process.env.GLASSBOARD_CONNECTOR_KIND??'hermes';
if(!endpoint||!endpoint.startsWith('https://'))throw new Error('GLASSBOARD_CONNECTOR_ENDPOINT must be HTTPS');
if(!['hermes','ollama'].includes(connector))throw new Error('Unsupported connector kind');
console.log(JSON.stringify({connector,endpoint,contractVersion:1,mode:'queue-worker',approvalRequired:true}));
