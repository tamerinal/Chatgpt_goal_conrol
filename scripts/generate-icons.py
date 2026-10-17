"""Render the existing circle/checkmark icon as native Windows PNG/ICO assets.

Run manually with Pillow. This script does not install packages or launch the app.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'resources'
root.mkdir(exist_ok=True)
scale = 8
image = Image.new('RGBA', (256 * scale, 256 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

def box(values):
    return tuple(round(value * scale * 8) for value in values)

draw.ellipse(box((2, 2, 30, 30)), fill='#0f9d75')
draw.ellipse(box((8, 8, 24, 24)), fill='#072b25')
points = [box(point) for point in [(12, 16.5), (14.5, 19), (20.5, 13)]]
width = round(2.4 * scale * 8)
draw.line(points, fill='#e8fff7', width=width, joint='curve')
for x, y in points:
    draw.ellipse((x-width/2, y-width/2, x+width/2, y+width/2), fill='#e8fff7')
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / 'icon.png')
image.resize((32, 32), Image.Resampling.LANCZOS).save(root / 'tray.png')
image.save(root / 'icon.ico', sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Generated icon.png, tray.png and icon.ico')
