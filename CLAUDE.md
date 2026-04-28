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

Opens at http://localhost:5000. Design a house through the four steps, then
"Generate Frame" runs Grasshopper and renders the timber members.
The server must run single-threaded (`threaded=False`) because .NET/RhinoCommon is not thread-safe.

## Project structure

- **src/** – Python (Flask + RhinoCommon glue). `app.py` routes; `specs.js` IS NOT here.
- **src/static/** – the front-end. `specs.js` is the single spec source of truth (drives preview AND the `/solve-frame` request body); `specMesher.js` renders specs to Three.js geometry.
- **tests/** – pytest. `conftest.py` handles `sys.path` and `rhinoinside.load()`.

## Key rule

The geometry spec (`src/static/specs.js`) is the only spec implementation. Both the on-screen preview and the Grasshopper input come from one `computeGeometrySpecs(uiState)` call. Don't reintroduce a Python copy.

## Multiple agents. 
User often runs two agents in parallel by simply launching two terminals in the same folder. Therefore you might sometimes clash with code being rewritten by another agent in front of you. Just fyi.
