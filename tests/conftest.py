import sys
import os

# Add src/ to the import path so tests can import project modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

# Initialize Rhino.Inside once per test session
import rhinoinside

rhinoinside.load(r"C:\Program Files\Rhino 8\System", "net8.0")
