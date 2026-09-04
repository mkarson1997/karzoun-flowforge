# Security Policy

## Supported versions

FlowForge is pre-1.0. Security fixes are applied to the latest release line.

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities in a public issue. Use GitHub's private vulnerability reporting feature when it is enabled for this repository, or contact the repository owner through a private channel listed on their GitHub profile.

Include, when possible:

- affected version or commit
- impact
- minimal reproduction
- preconditions
- suggested mitigation

## Security model

Workflow engines execute application-defined code and may process secrets or untrusted event payloads. Deployers are responsible for isolating workers, applying least privilege, protecting persistence credentials, authenticating trigger endpoints, and restricting plugin/task packages to trusted sources.

FlowForge will treat signed webhook verification, secret handling, tenant isolation, SSRF boundaries, and safe plugin execution as first-class security work as those subsystems are introduced.
