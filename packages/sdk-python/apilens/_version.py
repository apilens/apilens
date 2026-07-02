"""Single source of truth for the package version.

Read by ``apilens.__init__`` (exposed as ``apilens.__version__``), by the
ingest client's ``User-Agent`` string, and by the build backend
(``[tool.hatch.version]`` in ``pyproject.toml``).
"""

__version__ = "0.2.2"
