# GitHub CI/CD Guide for Contributors

## Overview

APILens uses **GitHub's native ecosystem** for CI/CD, security scanning, and dependency management. This replaces the previous local Docker-based Jenkins/SonarQube stack.

**Benefits:**
- ✅ Zero local infrastructure setup required
- ✅ Free for open-source projects (unlimited Actions minutes)
- ✅ Native integration with PR workflow
- ✅ Automatic security advisories and dependency updates
- ✅ CodeQL semantic analysis for 200+ security patterns

---

## Automated Workflows

### 1. Backend CI (`.github/workflows/backend-ci.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests targeting `main` or `develop`
- Changes to `backend/**` files

**Jobs:**

#### Lint (Ruff)
- Runs `ruff check` and `ruff format --check`
- Enforces Python code style and catches common errors
- **How to fix:** Run `ruff check backend/` and `ruff format backend/` locally

#### Test & Coverage
- Runs `pytest` with coverage tracking
- Tests: `backend/tests/`
- Coverage threshold: 50% (informational)
- Uploads coverage reports as artifacts
- **How to fix:** Run `pytest backend/tests/` locally

#### Security (Bandit)
- Scans for common security issues (SQL injection, hardcoded secrets, etc.)
- Runs on `api/`, `apps/`, `core/`, `config/` directories
- Continues on error (informational only)
- **How to fix:** Review Bandit report in Actions artifacts

**Local testing:**
```bash
cd backend
uv pip install --system -e .
uv pip install --system pytest pytest-cov ruff bandit

# Run linting
ruff check .
ruff format --check .

# Run tests
pytest tests/ --cov=api --cov=apps --cov=core --cov=config

# Run security scan
bandit -r api apps core config
```

---

### 2. Frontend CI (`.github/workflows/frontend-ci.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests targeting `main` or `develop`
- Changes to `frontend/**` files

**Jobs:**

#### Lint (ESLint)
- Runs `npm run lint`
- Enforces TypeScript/React code style
- **How to fix:** Run `npm run lint` locally (auto-fix with `npm run lint -- --fix`)

#### Type Check (TypeScript)
- Runs `tsc --noEmit`
- Validates TypeScript types without building
- **How to fix:** Run `npx tsc --noEmit` locally and fix type errors

#### Build (Next.js)
- Runs `npm run build`
- Verifies production build succeeds
- Caches `.next/cache` and `node_modules`
- **How to fix:** Run `npm run build` locally

#### Security (npm audit)
- Runs `npm audit` for vulnerable dependencies
- Continues on error (Dependabot will create fix PRs automatically)
- **How to fix:** Review Dependabot PRs or run `npm audit fix`

**Local testing:**
```bash
cd frontend
npm ci

# Run linting
npm run lint

# Run type check
npx tsc --noEmit

# Run build
npm run build

# Run security audit
npm audit
```

---

### 3. CodeQL Security Analysis (`.github/workflows/codeql.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests targeting `main` or `develop`
- **Scheduled:** Weekly on Monday at 6:00 AM UTC

**Languages analyzed:**
- **Python** (Django backend)
- **JavaScript/TypeScript** (Next.js frontend)

**What it does:**
- Semantic code analysis for security vulnerabilities
- Detects CWE Top 25 security patterns:
  - SQL injection
  - XSS (cross-site scripting)
  - Command injection
  - Path traversal
  - Authentication/authorization flaws
  - And 200+ more patterns
- Results appear in **Security → Code scanning alerts** tab

**How to view alerts:**
1. Go to repo's **Security** tab
2. Click **Code scanning alerts**
3. Filter by severity, language, or rule
4. Click alert for details + suggested fix

**How to fix:**
- CodeQL provides suggested fixes in the alert details
- Follow secure coding guidelines for your language
- Re-run the workflow to verify fix

---

### 4. Dependency Review (`.github/workflows/dependency-review.yml`)

**Triggers:**
- Pull requests only (blocks PRs with vulnerable dependencies)

**What it does:**
- Scans PR for new dependencies
- **Fails PR** if introducing HIGH or CRITICAL vulnerabilities
- **Warns** on MODERATE or LOW severity (informational)
- Comments on PR with vulnerability details

**How to fix:**
1. Review the PR comment showing vulnerable dependencies
2. Update to patched version: `uv pip install <package>==<safe-version>` (Python) or `npm install <package>@<safe-version>` (npm)
3. Push updated `pyproject.toml` or `package.json`
4. Workflow re-runs automatically

---

### 5. Dependabot (`.github/dependabot.yml`)

**Package ecosystems:**
- **pip** (backend): Weekly updates on Monday
- **npm** (frontend): Weekly updates on Monday
- **github-actions**: Monthly updates

**What it does:**
- Automatically opens PRs for dependency updates
- Groups minor/patch updates together (1 PR for multiple updates)
- Separate PRs for major versions (breaking changes)
- Security updates are **immediate** (not weekly)

**Configuration:**
- Max 5 open PRs per ecosystem
- Auto-labels PRs: `dependencies`, `python`/`javascript`, `backend`/`frontend`
- Commit message format: `chore(backend): update dependencies` or `chore(frontend): update dependencies`

**How to handle Dependabot PRs:**
1. Review the PR description (changelog links, release notes)
2. Check if CI passes (all workflows green)
3. For **security updates**: Merge immediately
4. For **minor/patch**: Merge when convenient
5. For **major updates**: Review breaking changes, test locally if needed

**Enable Dependabot alerts:**
1. Go to **Settings → Security → Code security and analysis**
2. Enable **Dependabot alerts** (get notified of vulnerabilities)
3. Enable **Dependabot security updates** (auto-create fix PRs)

---

## CI Status & Results

### Viewing Workflow Runs
1. Go to repo's **Actions** tab
2. Click workflow name (e.g., "Backend CI", "Frontend CI")
3. Click specific run to see job details
4. Expand job steps to see logs

### Viewing Security Alerts
1. **Code scanning (CodeQL):** Security → Code scanning alerts
2. **Dependency vulnerabilities:** Security → Dependabot alerts
3. **Secret scanning:** Security → Secret scanning alerts (if enabled)

### Downloading Artifacts
Some workflows upload reports as artifacts:
- **Backend CI:** Coverage reports (XML + HTML), Bandit security report
- **Frontend CI:** npm audit report

**How to download:**
1. Go to workflow run in Actions tab
2. Scroll to "Artifacts" section at bottom
3. Click artifact name to download ZIP

---

## Troubleshooting

### ❌ Backend CI: Lint failed
**Error:** `Ruff found linting errors`

**Fix:**
```bash
cd backend
ruff check . --fix  # Auto-fix issues
ruff format .       # Format code
git add .
git commit -m "fix: lint errors"
git push
```

---

### ❌ Backend CI: Tests failed
**Error:** `pytest` failed or coverage below threshold

**Fix:**
```bash
cd backend
pytest tests/ -v  # Run tests with verbose output
# Fix failing tests, then:
git add .
git commit -m "fix: failing tests"
git push
```

---

### ❌ Frontend CI: Type check failed
**Error:** `tsc --noEmit` found type errors

**Fix:**
```bash
cd frontend
npx tsc --noEmit  # See type errors
# Fix type issues in reported files, then:
git add .
git commit -m "fix: type errors"
git push
```

---

### ❌ Frontend CI: Build failed
**Error:** `npm run build` failed

**Fix:**
```bash
cd frontend
npm run build  # Reproduce error locally
# Fix build issues (usually missing env vars or type errors), then:
git add .
git commit -m "fix: build errors"
git push
```

---

### ❌ Dependency Review: PR blocked
**Error:** "Dependency Review found HIGH/CRITICAL vulnerabilities"

**Fix:**
1. Read the PR comment showing vulnerable packages
2. Update to safe version:
   - **Python:** `uv pip install <package>==<safe-version>`
   - **npm:** `npm install <package>@<safe-version>`
3. Commit updated lockfile:
   ```bash
   git add backend/pyproject.toml  # or frontend/package-lock.json
   git commit -m "fix: update vulnerable dependency"
   git push
   ```

---

### ⚠️ CodeQL: Security alert
**Error:** CodeQL detected potential security issue

**Fix:**
1. Go to **Security → Code scanning alerts**
2. Click alert for details (file, line, vulnerability type)
3. Review suggested fix or secure coding pattern
4. Apply fix to code
5. Push changes — CodeQL re-runs on next push/PR

---

## Best Practices

### Before Opening a PR
1. **Run linters locally:**
   - Backend: `ruff check backend/` and `ruff format backend/`
   - Frontend: `npm run lint` (auto-fix with `npm run lint -- --fix`)

2. **Run tests locally:**
   - Backend: `pytest backend/tests/`
   - Frontend: Currently no tests (coming soon)

3. **Run type check (frontend):**
   - `npx tsc --noEmit`

4. **Run build (frontend):**
   - `npm run build`

### After Opening a PR
1. Wait for all CI checks to pass (green ✓)
2. If checks fail, click "Details" to see logs
3. Fix issues and push — checks re-run automatically
4. Don't merge until all checks pass

### Handling Dependabot PRs
- **Security updates:** Merge ASAP (usually safe)
- **Minor/patch updates:** Review changelog, merge when ready
- **Major updates:** Test locally, review breaking changes

### Monitoring Security
- Check **Security** tab weekly for new alerts
- Enable GitHub notifications for security advisories
- Review and merge Dependabot PRs promptly

---

## Migration from Jenkins/SonarQube

**What was removed:**
- Local Docker stack (Jenkins + SonarQube + OWASP Dependency-Check)
- `devsecops/` directory (docker-compose, Dockerfiles, scripts)
- `Jenkinsfile` (pipeline configuration)
- `sonar-project.properties` (SonarQube config)

**What was added:**
- GitHub Actions workflows (backend-ci, frontend-ci, codeql, dependency-review)
- Dependabot configuration
- This guide

**Benefits:**
| Feature | Jenkins/SonarQube | GitHub Native |
|---------|------------------|---------------|
| Local setup | 3 Docker containers, 6GB RAM | None |
| Cost | Free (self-hosted) | Free (unlimited for open-source) |
| Security scanning | SonarQube | CodeQL (200+ patterns) |
| Dependency updates | OWASP Dependency-Check | Dependabot (auto PRs) |
| PR integration | Webhook setup | Native |
| Results location | Localhost dashboard | GitHub Security tab |

---

## Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [CodeQL Documentation](https://codeql.github.com/docs/)
- [Dependabot Documentation](https://docs.github.com/en/code-security/dependabot)
- [Dependency Review Action](https://github.com/actions/dependency-review-action)
- [Ruff Documentation](https://docs.astral.sh/ruff/)
- [Bandit Documentation](https://bandit.readthedocs.io/)

---

## Questions?

- **CI/CD issues:** Check Actions tab → Workflow run → Job logs
- **Security alerts:** Check Security tab → Code scanning alerts / Dependabot alerts
- **Contributor questions:** Open a GitHub Discussion or issue
