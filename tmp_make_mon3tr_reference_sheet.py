from pathlib import Path

from PIL import Image, ImageDraw


run = Path(r"D:\projects-personal-manager\reading-resources\未分类\mon3tr-pet-run")
refs = sorted((run / "references").glob("reference-*.png"))
names = [
    "base",
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
]

cell_w, cell_h = 220, 260
canvas = Image.new("RGB", (5 * cell_w, 2 * cell_h), "white")
draw = ImageDraw.Draw(canvas)

for i, path in enumerate(refs):
    im = Image.open(path).convert("RGB")
    im.thumbnail((cell_w - 20, cell_h - 45))
    x = (i % 5) * cell_w + (cell_w - im.width) // 2
    y = (i // 5) * cell_h + 10
    canvas.paste(im, (x, y))
    draw.text(((i % 5) * cell_w + 10, (i // 5) * cell_h + cell_h - 28), f"{i + 1:02d} {names[i]}", fill=(0, 0, 0))

out = run / "qa" / "input-reference-sheet.png"
out.parent.mkdir(parents=True, exist_ok=True)
canvas.save(out)
print(out)
