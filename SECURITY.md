# Security policy

## Supported versions

Security fixes are provided for the latest Seda minor release.

## Reporting

Please do not open a public issue for a suspected vulnerability. Use GitHub’s
private vulnerability reporting for `bearlyai/seda`, or email
security@bearly.ai with the repository name, affected version, reproduction,
and impact.

We will acknowledge a complete report within three business days and coordinate
disclosure after a fix is available.

## Trust boundaries

Seda downloads executable native runtimes and model weights. The embedded
catalog pins every artifact by URL, byte size, and SHA-256; a checksum mismatch
is a hard failure. The project does not execute model files as code, but native
runtime libraries are executable and should be treated as supply-chain inputs.

The in-browser runtime downloads its model and configuration from an immutable
Hugging Face Git revision and executes inference through the pinned
Transformers.js dependency. Applications with a stricter supply-chain policy
should mirror those assets and constrain `connect-src`. Browser audio remains
inside the page and its Worker; Seda does not upload it.

The local server is authenticated even on loopback. Keep startup tokens in a
trusted main process and never expose them to untrusted renderer or web content.
Do not use `--allow-network` without an application-level network security
design.
