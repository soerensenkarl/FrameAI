"""Export boxes to a .3dm file for viewing in Rhino."""
import Rhino
import Rhino.FileIO as rio
from box_gen import generate_box

model = rio.File3dm()

model.Objects.AddBrep(generate_box(500, 500, 2000))
model.Objects.AddBrep(generate_box(10000, 10000, 100000))

path = r"C:\FrameAI\output.3dm"
model.Write(path, rio.File3dmWriteOptions())
print(f"Saved to {path}")
