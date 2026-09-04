# Contributing to FlowForge

Thank you for helping improve FlowForge.

## Ground rules

- Keep changes focused and explain the problem they solve.
- Add tests for behavior changes and bug fixes.
- Preserve strict TypeScript settings.
- Avoid coupling the core engine to a specific database, queue, or web framework.
- Treat retry, timeout, idempotency, and recovery behavior as public contracts.

## Local setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

A good pull request includes:

1. The user or operational problem.
2. The chosen design and important tradeoffs.
3. Tests demonstrating the behavior.
4. Documentation updates when public behavior changes.

Large architectural changes should begin as a GitHub issue so the contract can be discussed before implementation.

## Commit style

Use concise conventional-style prefixes where useful, for example:

- `feat:` new behavior
- `fix:` bug fix
- `docs:` documentation
- `test:` tests
- `refactor:` internal change without public behavior change
- `chore:` repository maintenance
