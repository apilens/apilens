# apilens

### SettingUp Initial Project There is no First Release Yet
[//]: # ()
[//]: # ([![License: MIT]&#40;https://img.shields.io/badge/License-MIT-yellow.svg&#41;]&#40;https://opensource.org/licenses/MIT&#41;)

[//]: # ()
[//]: # (**apilens** is a modern observability platform for monitoring APIs. Built with Django, React, ClickHouse, and PostgreSQL.)

[//]: # ()
[//]: # (## Quick Start)

[//]: # ()
[//]: # (```bash)

[//]: # (# Clone the repository)

[//]: # (git clone https://github.com/apilens-in/apilens.git)

[//]: # (cd apilens)

[//]: # ()
[//]: # (# Run quickstart &#40;Docker only required&#41;)

[//]: # (./scripts/quickstart.sh)

[//]: # (```)

[//]: # ()
[//]: # (Access the application at http://localhost)

[//]: # ()
[//]: # (## Architecture)

[//]: # ()
[//]: # (```)

[//]: # (┌─────────────────────────────────────────────────────────────────┐)

[//]: # (│                         Load Balancer                            │)

[//]: # (│                           &#40;Nginx&#41;                                │)

[//]: # (└─────────────────────────┬───────────────────────────────────────┘)

[//]: # (                          │)

[//]: # (          ┌───────────────┼───────────────┐)

[//]: # (          │               │               │)

[//]: # (          ▼               ▼               ▼)

[//]: # (    ┌──────────┐    ┌──────────┐    ┌──────────┐)

[//]: # (    │ Frontend │    │  API     │    │  Worker  │)

[//]: # (    │ &#40;React&#41;  │    │ &#40;Django&#41; │    │ &#40;Celery&#41; │)

[//]: # (    └──────────┘    └────┬─────┘    └────┬─────┘)

[//]: # (                         │               │)

[//]: # (         ┌───────────────┼───────────────┤)

[//]: # (         │               │               │)

[//]: # (         ▼               ▼               ▼)

[//]: # (   ┌──────────┐    ┌──────────┐    ┌──────────┐)

[//]: # (   │PostgreSQL│    │ClickHouse│    │  Redis   │)

[//]: # (   │ &#40;Config&#41; │    │ &#40;Metrics&#41;│    │ &#40;Cache&#41;  │)

[//]: # (   └──────────┘    └──────────┘    └──────────┘)

[//]: # (```)

[//]: # ()
[//]: # (## Tech Stack)

[//]: # ()
[//]: # (| Component | Technology |)

[//]: # (|-----------|------------|)

[//]: # (| Backend API | Django 5 + Django Ninja |)

[//]: # (| Frontend | React 18 + Vite + TypeScript |)

[//]: # (| Analytics DB | ClickHouse |)

[//]: # (| Config DB | PostgreSQL |)

[//]: # (| Cache/Queue | Redis |)

[//]: # (| Task Queue | Celery |)

[//]: # (| Auth | Auth0 |)

[//]: # ()
[//]: # (## System Requirements)

[//]: # ()
[//]: # (| Resource | Minimum | Recommended |)

[//]: # (|----------|---------|-------------|)

[//]: # (| CPU | 2 cores | 4+ cores |)

[//]: # (| RAM | 4 GB | 8+ GB |)

[//]: # (| Storage | 20 GB | 100+ GB SSD |)

[//]: # (| Docker | 20.10+ | Latest |)

[//]: # ()
[//]: # (## Installation)

[//]: # ()
[//]: # (### Option 1: Docker &#40;Recommended&#41;)

[//]: # ()
[//]: # (```bash)

[//]: # (# Development)

[//]: # (docker-compose up -d)

[//]: # ()
[//]: # (# Production)

[//]: # (docker-compose -f docker-compose.prod.yml up -d)

[//]: # (```)

[//]: # ()
[//]: # (### Option 2: Local Development)

[//]: # ()
[//]: # (```bash)

[//]: # (# Run setup script)

[//]: # (./scripts/setup-dev.sh)

[//]: # ()
[//]: # (# Or manually:)

[//]: # (# 1. Install dependencies)

[//]: # (uv sync --extra dev)

[//]: # (cd static && npm install && cd ..)

[//]: # ()
[//]: # (# 2. Start services)

[//]: # (docker-compose up -d)

[//]: # ()
[//]: # (# 3. Run migrations)

[//]: # (cd src && python manage.py migrate)

[//]: # ()
[//]: # (# 4. Start servers)

[//]: # (python manage.py runserver  # Backend)

[//]: # (cd ../static && npm run dev  # Frontend)

[//]: # (```)

[//]: # ()
[//]: # (### Option 3: Production VM)

[//]: # ()
[//]: # (```bash)

[//]: # (./scripts/deploy-vm.sh your-domain.com admin@email.com)

[//]: # (```)

[//]: # ()
[//]: # (## Development)

[//]: # ()
[//]: # (### Running the Backend)

[//]: # ()
[//]: # (```bash)

[//]: # (source .venv/bin/activate)

[//]: # (cd src)

[//]: # (python manage.py runserver)

[//]: # (```)

[//]: # ()
[//]: # (API available at http://localhost:8000/api/v1/)

[//]: # ()
[//]: # (### Running the Frontend)

[//]: # ()
[//]: # (```bash)

[//]: # (cd static)

[//]: # (npm run dev)

[//]: # (```)

[//]: # ()
[//]: # (Frontend available at http://localhost:3000)

[//]: # ()
[//]: # (### Running Tests)

[//]: # ()
[//]: # (```bash)

[//]: # (# All tests)

[//]: # (./scripts/test.sh)

[//]: # ()
[//]: # (# Backend only)

[//]: # (cd src && pytest)

[//]: # ()
[//]: # (# Frontend only)

[//]: # (cd static && npm test)

[//]: # (```)

[//]: # ()
[//]: # (### Code Quality)

[//]: # ()
[//]: # (```bash)

[//]: # (# Linting)

[//]: # (ruff check src/)

[//]: # (cd static && npm run lint)

[//]: # ()
[//]: # (# Formatting)

[//]: # (black src/)

[//]: # (cd static && npm run format)

[//]: # (```)

[//]: # ()
[//]: # (## Project Structure)

[//]: # ()
[//]: # (```)

[//]: # (apilens/)

[//]: # (├── src/                    # Django backend)

[//]: # (│   ├── api/               # API endpoints)

[//]: # (│   │   └── v1/           # API version 1)

[//]: # (│   ├── apps/             # Django apps)

[//]: # (│   ├── config/           # Django settings)

[//]: # (│   │   └── settings/     # Environment configs)

[//]: # (│   ├── core/             # Shared utilities)

[//]: # (│   │   ├── auth/        # Authentication)

[//]: # (│   │   └── database/    # Database clients)

[//]: # (│   └── tests/            # Test files)

[//]: # (├── static/                # React frontend)

[//]: # (│   ├── src/              # Source code)

[//]: # (│   └── dist/             # Build output)

[//]: # (├── infrastructure/        # Deployment configs)

[//]: # (│   ├── docker/           # Dockerfiles)

[//]: # (│   └── systemd/          # Service files)

[//]: # (├── scripts/               # Utility scripts)

[//]: # (├── docker-compose.yml     # Development services)

[//]: # (└── docker-compose.prod.yml # Production services)

[//]: # (```)

[//]: # ()
[//]: # (## Environment Variables)

[//]: # ()
[//]: # (Copy `.env.example` to `.env` and configure:)

[//]: # ()
[//]: # (```bash)

[//]: # (cp .env.example .env)

[//]: # (```)

[//]: # ()
[//]: # (Key variables:)

[//]: # (- `DJANGO_SECRET_KEY` - Django secret key)

[//]: # (- `POSTGRES_*` - PostgreSQL connection)

[//]: # (- `CLICKHOUSE_*` - ClickHouse connection)

[//]: # (- `AUTH0_*` - Auth0 configuration)

[//]: # (- `VITE_*` - Frontend configuration)

[//]: # ()
[//]: # (## API Documentation)

[//]: # ()
[//]: # (When running, access API docs at:)

[//]: # (- Swagger UI: http://localhost:8000/api/v1/docs)

[//]: # (- OpenAPI JSON: http://localhost:8000/api/v1/openapi.json)

[//]: # ()
[//]: # (## Contributing)

[//]: # ()
[//]: # (See [CONTRIBUTING.md]&#40;CONTRIBUTING.md&#41; for guidelines.)

[//]: # ()
[//]: # (## License)

[//]: # ()
[//]: # (This project is licensed under the MIT License - see [LICENSE]&#40;LICENSE&#41; for details.)
