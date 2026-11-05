#!/usr/bin/env python3
"""Prompt City · Gen 0 Citizens: 5,555 pixel characters, 28x28, neon-sunset city style.

Usage:  python3 citizens.py OUT_DIR [--count N] [--seed S]
Writes OUT_DIR/images/<id>.png (28x28), OUT_DIR/thumbs/<id>.png (252x252), OUT_DIR/collection.json.
Rarity = wanted level: Street ★ · Hustler ★★ · Boss ★★★ · Kingpin ★★★★ · Legend ★★★★★.
Higher tiers unlock rarer traits (gold skin, crowns, police-light turf...). Same seed -> same collection.
"""
import json, os, random, sys
from PIL import Image

W = H = 28
TIERS = [  # name, stars, count in a 5,555 supply
    ("Street", 1, 2900), ("Hustler", 2, 1500), ("Boss", 3, 700), ("Kingpin", 4, 300), ("Legend", 5, 155),
]
TIER_IX = {t[0]: i for i, t in enumerate(TIERS)}

def hx(s):
    s = s.lstrip("#"); return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4)) + (255,)

def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c[:3]) + (255,)

INK = hx("120626"); WHITE = hx("FFF3E6"); GOLD = hx("FFD23F"); GOLD_D = hx("C9961A")
PINK = hx("FF4FA3"); CYAN = hx("2DE2E6"); ORANGE = hx("FF8A3D"); PURPLE = hx("6B1A7A")

class Canvas:
    def __init__(self):
        self.p = [[(0, 0, 0, 0)] * W for _ in range(H)]
    def px(self, x, y, c):
        if 0 <= x < W and 0 <= y < H and c is not None:
            self.p[y][x] = c
    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)
    def get(self, x, y):
        return self.p[y][x]
    def image(self):
        im = Image.new("RGBA", (W, H))
        im.putdata([c for row in self.p for c in row])
        return im.convert("RGB")

# ---------------------------------------------------------------- traits
# each option: (name, weights per tier [Street, Hustler, Boss, Kingpin, Legend])
def pick(rng, opts, tier):
    names = [o[0] for o in opts]; ws = [o[1][tier] for o in opts]
    return rng.choices(names, weights=ws, k=1)[0]

TURF = [
    ("Sunset Strip", [30, 26, 22, 16, 10]), ("Neon Night", [22, 22, 20, 16, 10]), ("Ocean Drive", [22, 20, 18, 14, 8]),
    ("Skyline", [16, 18, 18, 16, 10]), ("Hot Pink", [20, 14, 8, 4, 0]), ("Teal Wall", [20, 14, 8, 4, 0]),
    ("Orange Wall", [16, 12, 8, 4, 0]), ("Police Lights", [0, 4, 12, 22, 20]), ("Cash Rain", [0, 0, 3, 10, 22]),
    ("Golden Hour", [0, 0, 0, 4, 20]),
]
SKIN = [
    ("Porcelain", [18, 16, 14, 12, 8]), ("Sand", [20, 18, 16, 12, 8]), ("Tan", [20, 18, 16, 12, 8]),
    ("Bronze", [18, 18, 16, 12, 8]), ("Umber", [18, 18, 16, 12, 8]), ("Espresso", [16, 16, 16, 12, 8]),
    ("Chrome", [0, 0, 2, 8, 14]), ("Gold", [0, 0, 0, 3, 14]), ("Neon Ghost", [0, 1, 4, 8, 12]),
]
SKIN_C = {"Porcelain": "F6D3BE", "Sand": "E8B98F", "Tan": "C98E62", "Bronze": "A86B43", "Umber": "7D4B2E",
          "Espresso": "53311F", "Chrome": "B9C3CF", "Gold": "F2C14E", "Neon Ghost": "9EF0F2"}
HAIR = [
    ("Buzz Cut", [16, 14, 12, 10, 8]), ("Slick Back", [12, 14, 16, 16, 16]), ("Mullet", [12, 12, 10, 8, 6]),
    ("Afro", [10, 10, 10, 10, 8]), ("Ponytail", [10, 10, 10, 8, 6]), ("Mohawk", [6, 8, 10, 10, 8]),
    ("Curtains", [12, 12, 10, 8, 6]), ("Long", [10, 10, 10, 8, 6]), ("Bald", [10, 8, 8, 8, 10]),
    ("Braids", [8, 10, 10, 10, 8]),
]
HAIR_COLOR = [("Black", "1B1020"), ("Brown", "5A3420"), ("Blonde", "F2D06B"), ("Bleach", "F4EFE2"),
              ("Ginger", "D9622B"), ("Pink", "FF6FB5"), ("Teal", "2DCBD0"), ("Grey", "9A97A6")]
LID = [
    ("No Lid", [40, 34, 28, 22, 14]), ("Backwards Cap", [14, 14, 12, 10, 6]), ("Bandana", [12, 12, 12, 10, 6]),
    ("Beanie", [12, 10, 8, 6, 4]), ("Bucket Hat", [10, 10, 8, 6, 4]), ("Headphones", [8, 10, 10, 8, 6]),
    ("Fedora", [0, 4, 10, 12, 10]), ("Cowboy Hat", [0, 3, 8, 10, 8]), ("Balaclava", [0, 2, 6, 12, 12]),
    ("Crown", [0, 0, 0, 2, 18]),
]
OPTICS = [
    ("Plain Eyes", [44, 36, 26, 18, 10]), ("Aviators", [12, 16, 18, 18, 14]), ("Neon Shades", [12, 14, 16, 14, 10]),
    ("Cyber Visor", [4, 8, 12, 14, 12]), ("Eye Patch", [4, 6, 8, 8, 6]), ("Sleepy", [14, 10, 6, 4, 2]),
    ("Laser Eyes", [0, 0, 2, 8, 16]),
]
MOUTH = [
    ("Straight", [36, 30, 24, 18, 12]), ("Smirk", [20, 20, 20, 18, 14]), ("Grin", [14, 14, 14, 14, 12]),
    ("Gold Tooth", [4, 8, 12, 16, 18]), ("Toothpick", [10, 10, 10, 10, 8]), ("Bubble Gum", [10, 10, 8, 6, 4]),
    ("Cigar", [0, 4, 10, 14, 16]), ("Mustache", [8, 10, 12, 12, 10]),
]
FIT = [
    ("White Tank", [20, 14, 10, 6, 2]), ("Hoodie", [18, 14, 10, 6, 2]), ("Tracksuit", [16, 16, 12, 8, 4]),
    ("Palm Shirt", [16, 18, 18, 14, 8]), ("Leather Jacket", [10, 14, 16, 16, 12]), ("Jumpsuit", [12, 10, 8, 6, 4]),
    ("Pastel Suit", [2, 6, 12, 16, 14]), ("Black Suit", [0, 4, 10, 16, 16]), ("Gold Suit", [0, 0, 0, 4, 18]),
]
BLING = [
    ("No Bling", [52, 40, 26, 14, 4]), ("Gold Chain", [14, 20, 24, 24, 20]), ("Earring", [20, 18, 14, 10, 6]),
    ("$ Pendant", [4, 10, 16, 20, 20]), ("Diamond Chain", [0, 0, 6, 14, 24]),
]
INKS = [
    ("No Ink", [70, 60, 52, 44, 36]), ("Star Tattoo", [10, 14, 16, 18, 18]), ("Neck Script", [8, 12, 14, 16, 16]),
    ("Scar", [12, 14, 16, 18, 18]),
]

# ---------------------------------------------------------------- drawing
def draw_turf(c, turf, rng):
    if turf == "Sunset Strip":
        bands = ["2A0B4F", "3F1060", "6B1A7A", "A0237F", "D63C8F", "FF4FA3", "FF6F7E", "FF8A3D", "FFB443", "FFD23F"]
        for y in range(H):
            c.rect(0, y, W - 1, y, hx(bands[min(len(bands) - 1, y * len(bands) // H)]))
        for y in range(2, 11):  # sun, top right, with stripes
            for x in range(17, 28):
                if (x - 22) ** 2 + (y - 7) ** 2 <= 20 and y not in (8, 10):
                    c.px(x, y, hx("FFE66B"))
    elif turf == "Neon Night":
        c.rect(0, 0, W - 1, H - 1, hx("140726"))
        for _ in range(12):
            c.px(rng.randrange(W), rng.randrange(15), WHITE if rng.random() < .5 else CYAN)
        c.rect(0, 20, W - 1, 20, PINK); c.rect(0, 24, W - 1, 24, shade(PINK, .7))
        for x in range(0, W, 4):
            c.rect(x, 21, x, H - 1, shade(PINK, .5))
    elif turf == "Ocean Drive":
        for y in range(H):
            c.rect(0, y, W - 1, y, hx("7FE7EA") if y < 10 else hx("47D6DB") if y < 18 else hx("1E8FB0"))
        c.rect(0, 18, W - 1, 18, WHITE)
        for (x, y) in [(2, 9), (2, 10), (2, 11), (3, 12), (3, 13), (3, 14), (3, 15), (3, 16), (3, 17)]:  # palm trunk
            c.px(x, y, hx("3A2050"))
        for (x, y) in [(0, 8), (1, 7), (2, 7), (3, 7), (4, 7), (5, 8), (1, 9), (4, 8), (0, 9), (5, 9), (3, 6), (2, 6)]:
            c.px(x, y, hx("1F6B4A"))
    elif turf == "Skyline":
        c.rect(0, 0, W - 1, H - 1, hx("2A0B4F"))
        for y in range(10):
            c.rect(0, y, W - 1, y, hx("3B1166") if y > 4 else hx("2A0B4F"))
        bldg = [(0, 3, 9), (4, 6, 13), (21, 23, 8), (24, 27, 12)]
        for (x0, x1, top) in bldg:
            c.rect(x0, top, x1, H - 1, hx("170830"))
            for y in range(top + 1, H, 2):
                for x in range(x0 + 1, x1, 2):
                    if rng.random() < .55:
                        c.px(x, y, GOLD if rng.random() < .7 else CYAN)
    elif turf == "Hot Pink":
        c.rect(0, 0, W - 1, H - 1, hx("FF6FB5"))
    elif turf == "Teal Wall":
        c.rect(0, 0, W - 1, H - 1, hx("38D6D9"))
    elif turf == "Orange Wall":
        c.rect(0, 0, W - 1, H - 1, hx("FF9A52"))
    elif turf == "Police Lights":
        c.rect(0, 0, 13, H - 1, hx("E02B4A")); c.rect(14, 0, W - 1, H - 1, hx("2B5BE0"))
        c.rect(0, 0, 13, 2, hx("FF7A8C")); c.rect(14, 0, W - 1, 2, hx("7FA2FF"))
    elif turf == "Cash Rain":
        c.rect(0, 0, W - 1, H - 1, hx("1E5E3A"))
        for _ in range(16):
            x, y = rng.randrange(W - 2), rng.randrange(H - 1)
            c.rect(x, y, x + 2, y + 1, hx("7BD88F")); c.px(x + 1, y, hx("2F8A4D"))
    elif turf == "Golden Hour":
        for y in range(H):
            c.rect(0, y, W - 1, y, hx(["FFE9A8", "FFD86B", "FFC14E", "FFA63D"][y * 4 // H]))

def draw_body(c, fit, skin, tier):
    s = hx(SKIN_C[skin]); sd = shade(s, .82)
    c.rect(12, 19, 15, 21, sd)  # neck
    col = {"White Tank": WHITE, "Hoodie": hx("3B3F58"), "Tracksuit": hx("2B5BE0"), "Palm Shirt": hx("FF6F7E"),
           "Leather Jacket": hx("231725"), "Jumpsuit": hx("FF7A1A"), "Pastel Suit": hx("8FE3D6"),
           "Black Suit": hx("17131F"), "Gold Suit": GOLD}[fit]
    for y in range(21, H):
        x0, x1 = (6, 21) if y == 21 else (5, 22) if y == 22 else (4, 23)
        c.rect(x0, y, x1, y, col)
    if fit == "White Tank":
        c.rect(8, 21, 10, 27, s); c.rect(17, 21, 19, 27, s)  # bare shoulders
        c.rect(4, 23, 7, 27, s); c.rect(20, 23, 23, 27, s)
        c.rect(12, 21, 15, 22, s)
    elif fit == "Hoodie":
        c.rect(10, 21, 17, 21, shade(col, 1.3)); c.px(12, 23, WHITE); c.px(15, 23, WHITE)
        c.px(12, 24, WHITE); c.px(15, 24, WHITE)
    elif fit == "Tracksuit":
        c.rect(13, 21, 14, 27, WHITE); c.rect(6, 22, 6, 27, WHITE); c.rect(21, 22, 21, 27, WHITE)
    elif fit == "Palm Shirt":
        for (x, y) in [(6, 23), (9, 25), (19, 23), (17, 26), (22, 25), (7, 26), (11, 23), (20, 27)]:
            c.px(x, y, hx("2DE2A0")); c.px(x + 1, y, GOLD)
        c.rect(12, 21, 15, 22, s); c.px(12, 21, WHITE); c.px(15, 21, WHITE)
    elif fit == "Leather Jacket":
        c.rect(12, 21, 15, 27, WHITE); c.px(11, 22, shade(col, 1.6)); c.px(16, 22, shade(col, 1.6))
        c.px(10, 23, hx("8A8A9A")); c.px(17, 25, hx("8A8A9A"))
    elif fit == "Jumpsuit":
        c.rect(12, 21, 15, 22, s); c.rect(6, 23, 9, 25, WHITE); c.px(7, 24, INK); c.px(8, 24, INK); c.rect(13, 23, 14, 27, shade(col, .8))
    elif fit in ("Pastel Suit", "Black Suit", "Gold Suit"):
        shirt = WHITE if fit != "Black Suit" else hx("F25F86")
        c.rect(12, 21, 15, 27, shirt)
        tie = hx("120626") if fit != "Black Suit" else INK
        c.rect(13, 22, 14, 27, tie if fit != "Pastel Suit" else hx("FF4FA3"))
        c.px(11, 21, shade(col, .75)); c.px(16, 21, shade(col, .75)); c.px(11, 22, shade(col, .75)); c.px(16, 22, shade(col, .75))
        if fit == "Gold Suit":
            c.px(7, 23, WHITE); c.px(20, 25, WHITE)

def draw_head(c, skin):
    s = hx(SKIN_C[skin]); sd = shade(s, .82)
    c.rect(9, 7, 18, 18, s)
    for (x, y) in [(9, 7), (18, 7), (9, 18), (18, 18)]:
        c.px(x, y, None if False else c.get(x, y))
    c.px(9, 7, (0, 0, 0, 0)); c.px(18, 7, (0, 0, 0, 0))
    c.rect(18, 8, 18, 18, sd)  # side shade
    c.rect(10, 18, 17, 18, sd)  # jaw shade
    c.px(9, 18, (0, 0, 0, 0)); c.px(18, 18, (0, 0, 0, 0))
    c.rect(8, 12, 8, 14, sd); c.rect(19, 12, 19, 14, sd)  # ears
    c.px(14, 14, sd); c.px(14, 15, sd)  # nose
    return s, sd

def draw_eyes(c, optics, s):
    if optics == "Plain Eyes":
        c.px(11, 12, WHITE); c.px(12, 12, INK); c.px(15, 12, WHITE); c.px(16, 12, INK)
        c.rect(11, 11, 12, 11, shade(s, .55)); c.rect(15, 11, 16, 11, shade(s, .55))
    elif optics == "Sleepy":
        c.rect(11, 12, 12, 12, shade(s, .5)); c.rect(15, 12, 16, 12, shade(s, .5))
        c.px(12, 13, INK); c.px(16, 13, INK)
    elif optics == "Aviators":
        c.rect(10, 11, 17, 11, GOLD_D)
        c.rect(10, 12, 12, 13, hx("3A2A12")); c.rect(15, 12, 17, 13, hx("3A2A12"))
        c.px(10, 12, hx("8A6A2A")); c.px(15, 12, hx("8A6A2A")); c.px(13, 12, GOLD_D); c.px(14, 12, GOLD_D)
        c.px(9, 11, GOLD_D); c.px(18, 11, GOLD_D)
    elif optics == "Neon Shades":
        c.rect(9, 11, 18, 13, PINK); c.rect(10, 12, 12, 12, INK); c.rect(15, 12, 17, 12, INK)
        c.px(13, 13, shade(PINK, .7)); c.px(14, 13, shade(PINK, .7))
    elif optics == "Cyber Visor":
        c.rect(9, 11, 18, 12, CYAN); c.rect(10, 12, 17, 12, hx("0E7D86")); c.px(11, 11, WHITE)
    elif optics == "Eye Patch":
        c.px(15, 12, WHITE); c.px(16, 12, INK); c.rect(10, 11, 12, 13, INK)
        for x in range(9, 19): c.px(x, 10 if x < 13 else 9 if x < 16 else 8, INK)
    elif optics == "Laser Eyes":
        c.px(11, 12, hx("FF2B2B")); c.px(12, 12, WHITE); c.px(15, 12, hx("FF2B2B")); c.px(16, 12, WHITE)
        for x in range(17, W): c.px(x, 12, hx("FF2B2B")); c.px(x, 13 if x % 2 else 11, hx("FF8A8A"))
        for x in range(0, 11): c.px(x, 12, hx("FF2B2B"))

def draw_mouth(c, mouth, s):
    lip = shade(s, .55)
    if mouth == "Straight":
        c.rect(12, 16, 15, 16, lip)
    elif mouth == "Smirk":
        c.rect(12, 16, 14, 16, lip); c.px(15, 15, lip)
    elif mouth == "Grin":
        c.rect(12, 16, 15, 16, WHITE); c.px(11, 15, lip); c.px(16, 15, lip)
    elif mouth == "Gold Tooth":
        c.rect(12, 16, 15, 16, WHITE); c.px(14, 16, GOLD); c.px(11, 15, lip); c.px(16, 15, lip)
    elif mouth == "Toothpick":
        c.rect(12, 16, 14, 16, lip); c.px(15, 16, hx("E8C98A")); c.px(16, 16, hx("E8C98A")); c.px(17, 15, hx("E8C98A"))
    elif mouth == "Bubble Gum":
        c.rect(12, 15, 14, 17, hx("FF8FC8")); c.px(13, 16, hx("FFC2E1"))
    elif mouth == "Cigar":
        c.rect(12, 16, 13, 16, lip); c.rect(14, 16, 18, 16, hx("6B3B1E")); c.px(19, 16, ORANGE); c.px(20, 14, hx("C9C3D6")); c.px(21, 13, hx("C9C3D6"))
    elif mouth == "Mustache":
        c.rect(11, 15, 16, 15, hx("2A1810")); c.rect(12, 16, 15, 16, lip)

def draw_hair(c, hair, color, lid):
    h = hx(color); hd = shade(h, .75)
    covered = lid in ("Beanie", "Bucket Hat", "Fedora", "Cowboy Hat", "Balaclava", "Backwards Cap", "Bandana")
    if hair == "Bald":
        return
    if hair == "Buzz Cut":
        c.rect(10, 7, 17, 7, hd); c.rect(9, 8, 18, 8, hd); c.px(9, 9, hd); c.px(18, 9, hd)
    elif hair == "Slick Back":
        c.rect(10, 6, 17, 6, h); c.rect(9, 7, 18, 8, h); c.rect(9, 9, 9, 11, h); c.rect(18, 9, 18, 10, h)
        c.rect(11, 7, 16, 7, shade(h, 1.25))
    elif hair == "Mullet":
        c.rect(10, 6, 17, 6, h); c.rect(9, 7, 18, 8, h); c.rect(8, 9, 8, 19, h); c.rect(19, 9, 19, 19, h); c.rect(7, 16, 8, 20, hd)
    elif hair == "Afro":
        c.rect(8, 3, 19, 8, h); c.rect(7, 5, 20, 11, h); c.rect(9, 2, 18, 2, h); c.rect(7, 9, 8, 12, h); c.rect(19, 9, 20, 12, h)
        for (x, y) in [(10, 4), (14, 3), (17, 5), (9, 7), (16, 7)]: c.px(x, y, hd)
    elif hair == "Ponytail":
        c.rect(10, 6, 17, 6, h); c.rect(9, 7, 18, 8, h); c.rect(19, 8, 21, 9, h); c.rect(21, 10, 22, 15, h); c.px(20, 8, hd)
    elif hair == "Mohawk":
        c.rect(13, 1, 14, 7, h); c.rect(12, 3, 15, 6, h); c.px(13, 0, shade(h, 1.2))
    elif hair == "Curtains":
        c.rect(10, 6, 17, 6, h); c.rect(9, 7, 18, 9, h); c.rect(9, 10, 10, 11, h); c.rect(17, 10, 18, 11, h); c.px(13, 9, (0, 0, 0, 0) if False else hd); c.px(14, 8, hd)
    elif hair == "Long":
        c.rect(10, 6, 17, 6, h); c.rect(9, 7, 18, 8, h); c.rect(7, 8, 8, 22, h); c.rect(19, 8, 20, 22, h); c.rect(8, 9, 9, 13, h)
    elif hair == "Braids":
        c.rect(9, 6, 18, 8, hd)
        for x in (10, 12, 14, 16): c.rect(x, 6, x, 8, h)
        c.rect(8, 9, 8, 21, h); c.rect(19, 9, 19, 21, h); c.px(8, 22, GOLD); c.px(19, 22, GOLD)

def draw_lid(c, lid, rng):
    if lid == "Backwards Cap":
        col = rng.choice([PINK, CYAN, hx("2B5BE0"), INK, WHITE])
        c.rect(9, 5, 18, 8, col); c.rect(10, 4, 17, 4, col); c.rect(5, 8, 9, 8, shade(col, .7)); c.px(13, 5, shade(col, .7)); c.px(14, 5, shade(col, .7))
    elif lid == "Bandana":
        col = rng.choice([hx("E02B4A"), hx("2B5BE0"), PINK, INK])
        c.rect(9, 6, 18, 9, col); c.rect(10, 5, 17, 5, col); c.rect(19, 8, 21, 9, col); c.px(21, 10, col)
        for x in (10, 13, 16): c.px(x, 7, WHITE)
    elif lid == "Beanie":
        col = rng.choice([hx("FF7A1A"), PINK, CYAN, hx("2A1810")])
        c.rect(9, 4, 18, 9, col); c.rect(10, 3, 17, 3, col); c.rect(9, 9, 18, 9, shade(col, .75)); c.px(13, 2, shade(col, 1.2)); c.px(14, 2, shade(col, 1.2))
    elif lid == "Bucket Hat":
        col = rng.choice([WHITE, hx("F2D06B"), CYAN, hx("3B3F58")])
        c.rect(10, 4, 17, 7, col); c.rect(7, 8, 20, 9, shade(col, .85))
    elif lid == "Headphones":
        c.rect(10, 5, 17, 5, INK); c.rect(9, 6, 9, 10, INK); c.rect(18, 6, 18, 10, INK)
        c.rect(7, 11, 9, 15, PINK); c.rect(18, 11, 20, 15, PINK)
    elif lid == "Fedora":
        col = rng.choice([hx("17131F"), WHITE, hx("6B4A2E")])
        c.rect(10, 3, 17, 7, col); c.rect(7, 8, 20, 8, col); c.rect(10, 6, 17, 6, PINK if col != PINK else INK); c.px(13, 3, shade(col, .7)); c.px(14, 3, shade(col, .7))
    elif lid == "Cowboy Hat":
        col = hx("C9864A")
        c.rect(10, 3, 17, 7, col); c.rect(5, 8, 22, 8, col); c.px(5, 7, col); c.px(22, 7, col); c.rect(10, 7, 17, 7, shade(col, .7)); c.px(13, 3, shade(col, .8)); c.px(14, 3, shade(col, .8))
    elif lid == "Balaclava":
        col = rng.choice([INK, hx("3B3F58"), hx("1E5E3A")])
        c.rect(9, 6, 18, 18, col); c.rect(10, 5, 17, 5, col); c.rect(8, 10, 19, 15, col)
        return "mask"
    elif lid == "Crown":
        c.rect(9, 4, 18, 7, GOLD); c.rect(9, 7, 18, 7, GOLD_D)
        for x in (9, 12, 15, 18): c.rect(x, 2, x, 3, GOLD)
        c.px(11, 5, hx("E02B4A")); c.px(14, 5, CYAN); c.px(17, 5, hx("2BE07A"))
    return None

def draw_bling(c, bling):
    if bling == "Gold Chain":
        for x in range(11, 17): c.px(x, 22 if x in (11, 16) else 23, GOLD)
    elif bling == "Diamond Chain":
        for x in range(10, 18): c.px(x, 22 if x in (10, 17) else 23, WHITE if x % 2 else CYAN)
        c.px(13, 24, CYAN); c.px(14, 24, WHITE)
    elif bling == "$ Pendant":
        for x in range(11, 17): c.px(x, 22 if x in (11, 16) else 23, GOLD)
        c.rect(13, 24, 14, 26, GOLD); c.px(13, 25, GOLD_D)
    elif bling == "Earring":
        c.px(8, 15, GOLD)

def draw_ink(c, ink, s):
    if ink == "Star Tattoo":
        c.px(16, 14, INK)
    elif ink == "Neck Script":
        c.px(12, 20, INK); c.px(13, 19, INK); c.px(14, 20, INK); c.px(15, 19, INK)
    elif ink == "Scar":
        c.px(11, 14, shade(s, .6)); c.px(12, 15, shade(s, .6)); c.px(10, 13, shade(s, .6))

def make_citizen(rng, tier):
    t = {"Rarity": TIERS[tier][0]}
    t["Turf"] = pick(rng, TURF, tier); t["Skin"] = pick(rng, SKIN, tier)
    t["Hair"] = pick(rng, HAIR, tier); hcol = rng.choice(HAIR_COLOR); t["Hair Color"] = hcol[0]
    t["Lid"] = pick(rng, LID, tier); t["Optics"] = pick(rng, OPTICS, tier); t["Mouth"] = pick(rng, MOUTH, tier)
    t["Fit"] = pick(rng, FIT, tier); t["Bling"] = pick(rng, BLING, tier); t["Ink"] = pick(rng, INKS, tier)
    if t["Lid"] == "Balaclava":  # a mask hides hair and ink; keeps it readable
        t["Hair"] = "Hidden"; t["Ink"] = "No Ink"; t["Hair Color"] = "Hidden"
        if t["Mouth"] in ("Cigar", "Bubble Gum", "Mustache"): t["Mouth"] = "Straight"
        if t["Optics"] in ("Aviators", "Neon Shades", "Cyber Visor", "Eye Patch"): t["Optics"] = "Plain Eyes"
    if t["Lid"] in ("Fedora", "Cowboy Hat", "Bucket Hat", "Beanie") and t["Hair"] in ("Afro", "Mohawk"):
        t["Hair"] = "Buzz Cut"
    if t["Lid"] == "Headphones" and t["Hair"] == "Afro":
        t["Hair"] = "Curtains"
    return t, hcol[1]

def render(t, hcol, seed):
    rng = random.Random(seed)
    c = Canvas()
    draw_turf(c, t["Turf"], rng)
    # glow outline behind Legends
    body = Canvas()
    draw_body(body, t["Fit"], t["Skin"], 0)
    s, sd = draw_head(body, t["Skin"])
    draw_ink(body, t["Ink"], s)
    draw_eyes(body, t["Optics"] if t["Optics"] != "Laser Eyes" else "Plain Eyes", s)
    draw_mouth(body, t["Mouth"], s)
    if t["Hair"] != "Hidden":
        draw_hair(body, t["Hair"], hcol, t["Lid"])
    mask = draw_lid(body, t["Lid"], rng) if t["Lid"] != "No Lid" else None
    if mask:
        sk = hx(SKIN_C[t["Skin"]])
        body.rect(10, 11, 17, 13, sk)
        draw_eyes(body, t["Optics"] if t["Optics"] != "Laser Eyes" else "Plain Eyes", sk)
        body.rect(12, 16, 15, 16, sk)
        draw_mouth(body, t["Mouth"], sk)
    draw_bling(body, t["Bling"])
    if t["Rarity"] == "Legend":  # 1px neon outline
        glow = GOLD if t["Turf"] not in ("Golden Hour",) else PINK
        for y in range(H):
            for x in range(W):
                if body.get(x, y)[3] == 0 and any(0 <= x + dx < W and 0 <= y + dy < H and body.get(x + dx, y + dy)[3]
                                                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    c.px(x, y, glow)
    for y in range(H):
        for x in range(W):
            if body.get(x, y)[3]:
                c.px(x, y, body.get(x, y))
    if t["Optics"] == "Laser Eyes":
        draw_eyes(c, "Laser Eyes", hx(SKIN_C[t["Skin"]]))
    return c.image()

def main():
    out = sys.argv[1]
    count = 5555; seed = 20261105
    args = sys.argv[2:]
    if "--count" in args: count = int(args[args.index("--count") + 1])
    if "--seed" in args: seed = int(args[args.index("--seed") + 1])
    rng = random.Random(seed)
    tiers = []
    for i, (_, _, n) in enumerate(TIERS):
        tiers += [i] * round(n * count / 5555)
    tiers = (tiers + [0] * count)[:count]
    rng.shuffle(tiers)
    os.makedirs(os.path.join(out, "images"), exist_ok=True); os.makedirs(os.path.join(out, "thumbs"), exist_ok=True)
    seen = set(); items = []
    order = ["Rarity", "Turf", "Skin", "Hair", "Hair Color", "Lid", "Optics", "Mouth", "Fit", "Bling", "Ink"]
    for idx, tier in enumerate(tiers, start=1):
        for _ in range(200):
            t, hc = make_citizen(rng, tier)
            key = tuple(t[k] for k in order)
            if key not in seen:
                seen.add(key); break
        im = render(t, hc, seed * 10007 + idx)
        im.save(os.path.join(out, "images", f"{idx}.png"), optimize=True)
        im.resize((252, 252), Image.NEAREST).save(os.path.join(out, "thumbs", f"{idx}.png"), optimize=True)
        items.append({"id": idx, "name": f"Citizen #{idx}", "px": 1, "a": [[k, t[k]] for k in order]})
    col = {"slug": "citizens", "name": "Citizens",
           "description": "Gen 0 of Prompt City: 5,555 pixel citizens that live inside your AI. Wanted level is rarity.",
           "supply": count,
           "note": "image: /img/<id>.png, 28x28 pixel art at its native size when px = 1 (scale it up with nearest-neighbour), else 1008x1008. thumb: /thumb/<id>.png, 252x252.",
           "items": items}
    with open(os.path.join(out, "collection.json"), "w") as f:
        f.write("{\n" + ",\n".join(f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}' for k, v in col.items() if k != "items"))
        f.write(',\n  "items": [\n' + ",\n".join("    " + json.dumps(it, ensure_ascii=False, separators=(",", ":")) for it in items) + "\n  ]\n}\n")
    print(f"{len(items)} citizens, {len(seen)} unique")

if __name__ == "__main__":
    main()
