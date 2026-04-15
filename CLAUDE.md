# Vision:
A timber frame generator. Webplatform UI for simple user friendly house drawing by non-exports which connects to rhino grasshopper to generate the timber frame. UI should be clean and simple and the UX should take inspiration from simple fun modeling such as the house builder in Sims 4.

# Very important instructions from the user:
- Always use the most efficient elegant analytical approach. Avoid slow geometric operations.
- Always check that the full platform (Design - Generated Frame) works after adding features or changing code. 

#UI Look. 
- Things that are highlighted such as important buttons etc. should use the color #F9BC06

# FrameAI – Claude Code Project Rules

## Running tests

```bash
source .venv/Scripts/activate && python -m pytest tests/ -v
```

The venv lives at `.venv/` and includes `rhinoinside`, `pythonnet`, and `pytest`.
Rhino 8 is installed at `C:\Program Files\Rhino 8`; rhinoinside loads it headlessly via `net8.0`.

## Running the web app

```bash
cd src && source ../.venv/Scripts/activate && python app.py
```

Opens at http://localhost:5000. Adjust box dimensions with sliders, click "Download .3dm" to get a Rhino file.
The server must run single-threaded (`threaded=False`) because .NET/RhinoCommon is not thread-safe.

## Project structure

- **src/** – All geometry logic lives here. Every function that touches RhinoCommon belongs in `src/`.
- **tests/** – pytest tests. `conftest.py` handles `sys.path` and `rhinoinside.load()`.
- **gh_components/** – Grasshopper component wrappers (thin shims that call into `src/`).

## Key rule

All logic lives in `src/`. Grasshopper components and tests import from `src/` — they never contain geometry logic themselves.
