## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was tested

<!-- Commands run, scenarios tried. For UI changes include a screenshot or short recording. -->

## Checklist

- [ ] `make lint test` passes
- [ ] Generated code is up to date (`make gen`) when `api/*.yaml` or SQL queries changed
- [ ] New environment variables are in `.env.example`, `docker-compose.yml` and `docs/deployment.md`
- [ ] Permission-sensitive changes go through the single permission resolver and have tests
- [ ] No secrets, tokens or personal data in code, logs or fixtures
