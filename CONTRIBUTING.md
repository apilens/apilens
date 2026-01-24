# Contributing to ObserveX

Thank you for your interest in contributing to ObserveX! This document provides guidelines and information for contributors.

## Code of Conduct

Please read and follow our Code of Conduct. We expect all contributors to be respectful and professional.

## Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/observex.git
   cd observex
   ```

2. **Run Setup Script**
   ```bash
   ./scripts/setup-dev.sh
   ```

3. **Verify Setup**
   ```bash
   ./scripts/test.sh
   ```

## Branch Naming

Use descriptive branch names with prefixes:

| Prefix | Use Case | Example |
|--------|----------|---------|
| `feature/` | New features | `feature/add-trace-viewer` |
| `fix/` | Bug fixes | `fix/login-redirect` |
| `refactor/` | Code refactoring | `refactor/api-structure` |
| `docs/` | Documentation | `docs/api-examples` |
| `test/` | Test additions | `test/auth-coverage` |

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(api): add metrics aggregation endpoint

fix(auth): resolve token refresh race condition

docs(readme): update installation instructions
```

## Pull Request Process

1. **Create a Feature Branch**
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make Changes**
   - Write clean, readable code
   - Add tests for new functionality
   - Update documentation as needed

3. **Run Tests**
   ```bash
   ./scripts/test.sh
   ```

4. **Run Linters**
   ```bash
   # Backend
   ruff check src/
   black --check src/

   # Frontend
   cd static && npm run lint
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature
   ```
   Then create a Pull Request on GitHub.

6. **PR Description**
   - Clearly describe what the PR does
   - Reference any related issues
   - Include screenshots for UI changes

## Code Style

### Python (Backend)

- Follow [PEP 8](https://pep8.org/)
- Use [Black](https://black.readthedocs.io/) for formatting
- Use [Ruff](https://docs.astral.sh/ruff/) for linting
- Use type hints where possible
- Write docstrings for public functions

```python
def calculate_metrics(
    tenant_id: str,
    start_time: datetime,
    end_time: datetime,
) -> list[MetricResult]:
    """
    Calculate aggregated metrics for a tenant.

    Args:
        tenant_id: The tenant identifier
        start_time: Query start time
        end_time: Query end time

    Returns:
        List of aggregated metric results
    """
    ...
```

### TypeScript (Frontend)

- Follow the ESLint configuration
- Use Prettier for formatting
- Use TypeScript strict mode
- Prefer functional components with hooks

```typescript
interface MetricsChartProps {
  data: MetricData[];
  title: string;
}

export function MetricsChart({ data, title }: MetricsChartProps) {
  // Component implementation
}
```

## Testing Requirements

### Backend

- Minimum 80% code coverage for new code
- Use pytest for testing
- Mock external services

```python
def test_metrics_endpoint(client, auth_headers):
    response = client.get("/api/v1/metrics/", headers=auth_headers)
    assert response.status_code == 200
    assert "data" in response.json()
```

### Frontend

- Test components with Vitest
- Test user interactions
- Mock API calls

```typescript
describe('MetricsChart', () => {
  it('renders chart with data', () => {
    render(<MetricsChart data={mockData} title="Test" />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
```

## Documentation

- Update README.md for user-facing changes
- Add docstrings to new functions
- Update API documentation for endpoint changes
- Include inline comments for complex logic

## Questions?

- Open an issue for questions
- Join our Discord community
- Check existing issues and PRs

Thank you for contributing!
