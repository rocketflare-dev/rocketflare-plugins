# Security Policy

## Supported versions

Every plugin in this repository ships at one version and is tagged `X.Y.Z`. There are no maintained
release lines. Security fixes land on `main` and ship in the next release. An app takes a fix with
`pnpm plugin upgrade <id>` (driven by `/rf-plugin`), which applies each later release's porting note
to the copy in the app. A porting note says what changed. It describes the behaviour that was
fixed, not how to exploit it.

## Reporting a vulnerability

Please **do not** open a public issue for anything exploitable. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/rocketflare-dev/rocketflare-plugins/security/advisories/new).
Include the plugin, the reproduction steps and the impact you believe it has. You will get an
acknowledgement, and a fix or a reasoned response, before anything is made public.

A problem in the kit itself (sign-in, tenancy, the plugin seams) goes to the
[kit's reporting form](https://github.com/rocketflare-dev/rocketflare/security/advisories/new)
instead. If you are not sure which one it is, either form is fine.

Anything non-sensitive (a hardening suggestion, a dependency advisory) is fine as an
[ordinary issue](https://github.com/rocketflare-dev/rocketflare-plugins/issues/new) titled
"Security: ".

## How the plugins are audited

These plugins are audited with the kit's `/rf-security` skill, installed on a host app. The
findings stay private until their fixes are released. Fixed findings are published at
[rocketflare.dev/security/track-record/](https://rocketflare.dev/security/track-record/), each with
the release that fixed it.
