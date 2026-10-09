#!/usr/bin/env python3
"""Draws the app icon (1024x1024, gradient + capsule) and writes the asset catalog."""
import json
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "MedCourse", "Assets.xcassets")
S = 1024

top, bottom = (46, 133, 255), (115, 92, 250)
icon = Image.new("RGB", (S, S))
pixels = icon.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        pixels[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))

# A soft glow, then a capsule pill at 45°.
glow = Image.new("L", (S, S), 0)
ImageDraw.Draw(glow).ellipse((180, 120, 900, 840), fill=70)
glow = glow.filter(ImageFilter.GaussianBlur(120))
icon = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), icon, glow)

pill = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(pill)
w, h = 300, 640
box = ((S - w) // 2, (S - h) // 2, (S + w) // 2, (S + h) // 2)
# The capsule's shape is one mask: the top half white, the bottom half tinted, a seam between.
shape = Image.new("L", (S, S), 0)
ImageDraw.Draw(shape).rounded_rectangle(box, radius=w // 2, fill=255)
d.rectangle((0, 0, S, S // 2), fill=(255, 255, 255, 255))
d.rectangle((0, S // 2, S, S), fill=(214, 228, 255, 255))
d.rectangle((0, S // 2 - 5, S, S // 2 + 5), fill=(180, 198, 255, 255))
pill.putalpha(shape)
pill = pill.rotate(-45, resample=Image.BICUBIC)
shadow = pill.split()[3].filter(ImageFilter.GaussianBlur(28)).point(lambda v: int(v * 0.35))
icon.paste((20, 40, 120), (14, 26), shadow)
icon.paste(pill, (0, 0), pill)

appicon = os.path.join(ASSETS, "AppIcon.appiconset")
os.makedirs(appicon, exist_ok=True)
icon.save(os.path.join(appicon, "icon-1024.png"))
json.dump(
    {"images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
     "info": {"author": "xcode", "version": 1}},
    open(os.path.join(appicon, "Contents.json"), "w"), indent=2)

def color(name, rgb):
    folder = os.path.join(ASSETS, f"{name}.colorset")
    os.makedirs(folder, exist_ok=True)
    components = {"red": f"{rgb[0] / 255:.3f}", "green": f"{rgb[1] / 255:.3f}", "blue": f"{rgb[2] / 255:.3f}", "alpha": "1.000"}
    json.dump({"colors": [{"color": {"color-space": "srgb", "components": components}, "idiom": "universal"}],
               "info": {"author": "xcode", "version": 1}}, open(os.path.join(folder, "Contents.json"), "w"), indent=2)

color("AccentColor", (41, 120, 245))
color("LaunchBackground", (46, 133, 255))
json.dump({"info": {"author": "xcode", "version": 1}}, open(os.path.join(ASSETS, "Contents.json"), "w"), indent=2)
print("assets written")
