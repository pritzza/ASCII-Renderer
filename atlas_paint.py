"""
atlas_paint.py — GUI paint tool for editing a custom "Special RGBA Atlas" file.

----------------------------------------------------------------------
FILE FORMAT SPEC (authoritative)
----------------------------------------------------------------------

- Container: raw, headerless byte stream
- Pixel format: RGBA, 8 bits per channel (uint8)
- Dimensions: must be known out-of-band (e.g. from command line or metadata)
- Scan order: row-major, top-to-bottom, left-to-right
- File length: width * height * 4 bytes

Per-pixel layout:
    R (uint8), G (uint8), B (uint8), A (uint8)

Alpha semantics (the "special" rules):
    A == 0       → clear cell (transparent). RGB ignored.
    A == 1       → solid pixel cell. Use RGB as the opaque color.
    32 ≤ A ≤ 126 → ASCII glyph cell. A encodes a visible ASCII character,
                   RGB is the glyph’s color.
    other values → invalid/error (non-visible ASCII codes or out-of-range).

Coordinate system:
    (0,0) = top-left pixel
    x increases rightward, y increases downward
    Byte offset for (x,y):
        base = (y * width + x) * 4
        R = file[base + 0]
        G = file[base + 1]
        B = file[base + 2]
        A = file[base + 3]

Validity:
    - A file is well-formed if its size == width*height*4.
    - A file is content-valid if every A satisfies:
          (A==0) or (A==1) or (32 ≤ A ≤ 126).

Other notes:
    - No compression, no premultiply, no color profile.
    - Not a PNG; this is raw bytes for direct upload.
    - Stable for WebGL2: use gl.RGBA8 / gl.UNSIGNED_BYTE and disable
      premultiply & Y-flip on upload.

----------------------------------------------------------------------
USAGE (Python):
----------------------------------------------------------------------

# Load raw atlas:
import numpy as np
buf = np.fromfile("atlas.bin", dtype=np.uint8)
arr = buf.reshape((height, width, 4))  # HxWx4

# Interpret pixel:
r,g,b,a = arr[y,x]
if a==0:        # clear
elif a==1:      # solid pixel, RGB=(r,g,b)
elif 32<=a<=126:# glyph chr(a), RGB=(r,g,b)
else:           # invalid

----------------------------------------------------------------------
USAGE (WebGL2):
----------------------------------------------------------------------

# JS: fetch binary, upload with texImage2D
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8,
              width, height, 0,
              gl.RGBA, gl.UNSIGNED_BYTE, uint8Array);

# GLSL shader (exact alpha recovery):
int A = int(floor(texel.a * 255.0 + 0.5));
if (A==0) { ... } else if (A==1) { ... } else if (A>=32 && A<=126) { ... }

----------------------------------------------------------------------
This script provides a Tkinter GUI for painting/editing this format.
Left-click in "Pencil" mode → solid pixel (A=1).
Left-click in "Text" mode   → glyph cell (A=ord(last ASCII key)).
Right-click                 → clear (A=0).
"""

import os
import sys
import tkinter as tk
from tkinter import filedialog, colorchooser, messagebox, simpledialog
from typing import Optional, Tuple
import numpy as np
from PIL import Image, ImageDraw, ImageFont

VISIBLE_ASCII_MIN = 32
VISIBLE_ASCII_MAX = 126

DEFAULT_CELL = 24          # canvas pixels per atlas cell
DEFAULT_W, DEFAULT_H = 32, 16
CHECK_SCALE = 8            # checker size in canvas pixels

class AtlasModel:
    def __init__(self, w:int, h:int):
        self.w, self.h = w, h
        self.arr = np.zeros((h, w, 4), dtype=np.uint8)  # RGBA

    def load_raw(self, path:str, w:int, h:int):
        expected = w*h*4
        data = np.fromfile(path, dtype=np.uint8)
        if data.size != expected:
            raise ValueError(f"Size mismatch: expected {expected} bytes, got {data.size}. "
                             "Use correct width/height.")
        self.w, self.h = w, h
        self.arr = data.reshape((h, w, 4))

    def save_raw(self, path:str):
        self.arr.astype(np.uint8).tofile(path)

    def set_pixel(self, x:int, y:int, rgb:Tuple[int,int,int]):
        self.arr[y, x, 0:3] = rgb
        self.arr[y, x, 3] = 1

    def set_char(self, x:int, y:int, ch:str, rgb:Tuple[int,int,int]):
        if len(ch) != 1:
            raise ValueError("set_char requires a single character.")
        code = ord(ch)
        if not (VISIBLE_ASCII_MIN <= code <= VISIBLE_ASCII_MAX):
            raise ValueError("Character is not visible ASCII (32..126).")
        self.arr[y, x, 0:3] = rgb
        self.arr[y, x, 3] = code

    def clear(self, x:int, y:int):
        self.arr[y, x] = (0,0,0,0)

    def valid_mask(self) -> np.ndarray:
        a = self.arr[...,3]
        return (a==0) | (a==1) | ((a>=VISIBLE_ASCII_MIN) & (a<=VISIBLE_ASCII_MAX))

    # PNG preview with the same rendering rules used in the canvas.
    def export_preview_image(self, scale:int=16, font_path:Optional[str]=None) -> Image.Image:
        h, w = self.h, self.w
        out = Image.new("RGBA", (w*scale, h*scale), (0,0,0,0))
        draw = ImageDraw.Draw(out)

        # checkerboard
        c1, c2 = (200,200,200,255), (160,160,160,255)
        check = max(4, scale//2)
        for yy in range(0, h*scale, check):
            for xx in range(0, w*scale, check):
                fill = c1 if ((xx//check + yy//check) % 2)==0 else c2
                draw.rectangle([xx,yy,xx+check-1,yy+check-1], fill=fill)

        # font
        font = None
        if font_path:
            try:
                font = ImageFont.truetype(font_path, size=int(scale*0.75))
            except Exception:
                font = None
        if font is None:
            try:
                font = ImageFont.truetype("DejaVuSansMono.ttf", size=int(scale*0.75))
            except Exception:
                font = ImageFont.load_default()

        okmask = self.valid_mask()
        for y in range(h):
            for x in range(w):
                r,g,b,a = self.arr[y,x]
                x0, y0 = x*scale, y*scale
                x1, y1 = x0+scale-1, y0+scale-1
                if a == 0:
                    continue
                elif a == 1:
                    draw.rectangle([x0,y0,x1,y1], fill=(int(r),int(g),int(b),255))
                elif VISIBLE_ASCII_MIN <= a <= VISIBLE_ASCII_MAX:
                    ch = chr(int(a))
                    bbox = draw.textbbox((0,0), ch, font=font)
                    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
                    tx = x0 + (scale - tw)//2
                    ty = y0 + (scale - th)//2
                    draw.text((tx,ty), ch, font=font, fill=(int(r),int(g),int(b),255))
                else:
                    # invalid - red hatch
                    draw.rectangle([x0,y0,x1,y1], outline=(255,0,0,255), width=max(1, scale//8))
                    draw.line([x0,y0,x1,y1], fill=(255,0,0,255), width=max(1, scale//8))
                    draw.line([x1,y0,x0,y1], fill=(255,0,0,255), width=max(1, scale//8))
        return out


class AtlasPaintApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Atlas Paint (special RGBA alpha)")
        self.geometry("1000x700")
        self.model = AtlasModel(DEFAULT_W, DEFAULT_H)
        self.file_path: Optional[str] = None

        self.cell = DEFAULT_CELL
        self.mode = tk.StringVar(value="pencil")   # "pencil" or "text"
        self.current_color = (0, 255, 0)           # RGB
        self.last_char = "A"                       # most recently typed/pasted visible ASCII
        self.show_grid = tk.BooleanVar(value=True)

        self._build_ui()
        self._bind_keys()
        self._redraw_all()

    # ---------- UI ----------
    def _build_ui(self):
        self.menubar = tk.Menu(self)
        # File menu
        m_file = tk.Menu(self.menubar, tearoff=0)
        m_file.add_command(label="New...", command=self.new_atlas)
        m_file.add_command(label="Open...", command=self.open_atlas)
        m_file.add_command(label="Save", command=self.save_atlas)
        m_file.add_command(label="Save As...", command=self.save_atlas_as)
        m_file.add_separator()
        m_file.add_command(label="Export PNG Preview...", command=self.export_png)
        m_file.add_separator()
        m_file.add_command(label="Exit", command=self.destroy)
        self.menubar.add_cascade(label="File", menu=m_file)

        # Tools menu
        m_tools = tk.Menu(self.menubar, tearoff=0)
        m_tools.add_radiobutton(label="Pencil (opaque pixel)", variable=self.mode, value="pencil",
                                command=self._update_status)
        m_tools.add_radiobutton(label="Text (glyphs from last typed char)", variable=self.mode, value="text",
                                command=self._update_status)
        m_tools.add_separator()
        m_tools.add_command(label="Pick Color…", command=self.pick_color)
        m_tools.add_checkbutton(label="Show Grid", variable=self.show_grid, command=self._redraw_all)
        m_tools.add_separator()
        m_tools.add_command(label="Validate Atlas", command=self.validate_atlas)
        self.menubar.add_cascade(label="Tools", menu=m_tools)

        # View menu
        m_view = tk.Menu(self.menubar, tearoff=0)
        m_view.add_command(label="Cell Size: Smaller", command=lambda: self.set_cell_size(max(8, self.cell-2)))
        m_view.add_command(label="Cell Size: Larger", command=lambda: self.set_cell_size(min(96, self.cell+2)))
        self.menubar.add_cascade(label="View", menu=m_view)

        self.config(menu=self.menubar)

        # top toolbar
        toolbar = tk.Frame(self, padx=6, pady=4)
        tk.Radiobutton(toolbar, text="Pencil", variable=self.mode, value="pencil",
                       command=self._update_status).pack(side=tk.LEFT)
        tk.Radiobutton(toolbar, text="Text", variable=self.mode, value="text",
                       command=self._update_status).pack(side=tk.LEFT)
        tk.Button(toolbar, text="Pick Color", command=self.pick_color).pack(side=tk.LEFT, padx=6)
        self.color_preview = tk.Canvas(toolbar, width=24, height=24, highlightthickness=1, highlightbackground="#444")
        self.color_preview.pack(side=tk.LEFT)
        self._update_color_preview()
        tk.Checkbutton(toolbar, text="Grid", variable=self.show_grid, command=self._redraw_all).pack(side=tk.LEFT, padx=6)
        tk.Button(toolbar, text="Validate", command=self.validate_atlas).pack(side=tk.LEFT, padx=6)
        tk.Button(toolbar, text="Export PNG", command=self.export_png).pack(side=tk.LEFT, padx=6)
        toolbar.pack(fill=tk.X)

        # canvas
        self.canvas = tk.Canvas(self, bg="#999", cursor="tcross")
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Button-1>", self.on_left_click)
        self.canvas.bind("<B1-Motion>", self.on_left_drag)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<Leave>", lambda e: self._update_status(None))

        # status bar
        self.status = tk.StringVar()
        status_bar = tk.Label(self, textvariable=self.status, anchor="w", relief=tk.SUNKEN)
        status_bar.pack(fill=tk.X, side=tk.BOTTOM)
        self._update_status()

        # handle resize
        self.canvas.bind("<Configure>", lambda e: self._redraw_all())

    def _bind_keys(self):
        # Capture printable ASCII to set last_char
        self.bind("<Key>", self.on_key)
        # Paste support: Ctrl/Cmd+V
        self.bind_all("<Control-v>", self.on_paste)
        self.bind_all("<Command-v>", self.on_paste)  # mac

        # Quick toggles
        self.bind("<Key-p>", lambda e: self._set_mode("pencil"))
        self.bind("<Key-t>", lambda e: self._set_mode("text"))

        # +/- to change cell size
        self.bind("<Key-minus>", lambda e: self.set_cell_size(max(8, self.cell-2)))
        self.bind("<Key-equal>", lambda e: self.set_cell_size(min(96, self.cell+2)))  # '=' is '+'

    # ---------- Actions ----------
    def parse_xy(self, event) -> Optional[Tuple[int,int]]:
        x = event.x // self.cell
        y = event.y // self.cell
        if 0 <= x < self.model.w and 0 <= y < self.model.h:
            return int(x), int(y)
        return None

    def on_left_click(self, event):
        pos = self.parse_xy(event)
        if pos is None: return
        x,y = pos
        if self.mode.get() == "pencil":
            self.model.set_pixel(x,y,self.current_color)
        else:
            # text mode: stamp last_char
            try:
                self.model.set_char(x,y,self.last_char,self.current_color)
            except ValueError:
                messagebox.showwarning("Invalid char", f"'{repr(self.last_char)}' is not visible ASCII (32..126).")
        self._draw_cell(x,y)

    def on_left_drag(self, event):
        pos = self.parse_xy(event)
        if pos is None: return
        x,y = pos
        if self.mode.get() == "pencil":
            self.model.set_pixel(x,y,self.current_color)
        else:
            try:
                self.model.set_char(x,y,self.last_char,self.current_color)
            except ValueError:
                pass
        self._draw_cell(x,y)

    def on_right_click(self, event):
        pos = self.parse_xy(event)
        if pos is None: return
        x,y = pos
        self.model.clear(x,y)
        self._draw_cell(x,y)

    def on_motion(self, event):
        pos = self.parse_xy(event)
        self._update_status(pos)

    def on_key(self, event):
        if event.char and len(event.char)==1:
            c = event.char
            if VISIBLE_ASCII_MIN <= ord(c) <= VISIBLE_ASCII_MAX:
                self.last_char = c
                self._update_status()
        # ignore other keys

    def on_paste(self, event=None):
        try:
            s = self.clipboard_get()
        except Exception:
            return
        if not s: return
        # take the first visible ASCII char
        for ch in s:
            if VISIBLE_ASCII_MIN <= ord(ch) <= VISIBLE_ASCII_MAX:
                self.last_char = ch
                self._update_status()
                return
        messagebox.showwarning("Paste", "Clipboard has no visible ASCII character (32..126).")

    def pick_color(self):
        initial = '#%02x%02x%02x' % self.current_color
        color = colorchooser.askcolor(initialcolor=initial, title="Pick RGB color")
        if color and color[0]:
            r,g,b = map(int, color[0])
            self.current_color = (r,g,b)
            self._update_color_preview()
            self._update_status()

    def set_cell_size(self, sz:int):
        self.cell = int(sz)
        self._redraw_all()

    def _set_mode(self, mode:str):
        self.mode.set(mode)
        self._update_status()

    # ---------- File ops ----------
    def new_atlas(self):
        w = simpledialog.askinteger("New Atlas", "Width (cells):", initialvalue=DEFAULT_W, minvalue=1, maxvalue=4096)
        if w is None: return
        h = simpledialog.askinteger("New Atlas", "Height (cells):", initialvalue=DEFAULT_H, minvalue=1, maxvalue=4096)
        if h is None: return
        self.model = AtlasModel(w,h)
        self.file_path = None
        self._redraw_all()

    def open_atlas(self):
        path = filedialog.askopenfilename(title="Open raw atlas", filetypes=[("Raw RGBA", "*.bin *.raw *.*")])
        if not path: return
        # ask for dimensions
        w = simpledialog.askinteger("Open Atlas", "Width (cells):", initialvalue=self.model.w, minvalue=1, maxvalue=16384)
        if w is None: return
        h = simpledialog.askinteger("Open Atlas", "Height (cells):", initialvalue=self.model.h, minvalue=1, maxvalue=16384)
        if h is None: return
        try:
            self.model.load_raw(path, w, h)
        except Exception as e:
            messagebox.showerror("Open failed", str(e))
            return
        self.file_path = path
        self._redraw_all()

    def save_atlas(self):
        if not self.file_path:
            return self.save_atlas_as()
        try:
            self.model.save_raw(self.file_path)
        except Exception as e:
            messagebox.showerror("Save failed", str(e))
            return
        self._flash_status(f"Saved: {os.path.basename(self.file_path)}")

    def save_atlas_as(self):
        path = filedialog.asksaveasfilename(title="Save raw atlas", defaultextension=".bin",
                                            filetypes=[("Raw RGBA", "*.bin *.raw"), ("All files","*.*")])
        if not path: return
        self.file_path = path
        self.save_atlas()

    def export_png(self):
        path = filedialog.asksaveasfilename(title="Export PNG preview", defaultextension=".png",
                                            filetypes=[("PNG image","*.png")])
        if not path: return
        try:
            img = self.model.export_preview_image(scale=max(8, self.cell), font_path=None)
            img.save(path)
        except Exception as e:
            messagebox.showerror("Export failed", str(e))
            return
        self._flash_status(f"Exported preview: {os.path.basename(path)}")

    def validate_atlas(self):
        ok = self.model.valid_mask()
        total = ok.size
        bad = int((~ok).sum())
        pct = 100*(total-bad)/total
        messagebox.showinfo("Validation", f"Valid cells: {total-bad}/{total} ({pct:.2f}%)")
        # draw invalid overlays immediately visible
        self._redraw_all()

    # ---------- Drawing ----------
    def _canvas_size(self):
        return (self.model.w*self.cell, self.model.h*self.cell)

    def _redraw_all(self):
        cw, ch = self._canvas_size()
        self.canvas.delete("all")
        self.canvas.config(scrollregion=(0,0,cw,ch))
        # checkerboard
        self._draw_checkerboard()
        # cells
        for y in range(self.model.h):
            for x in range(self.model.w):
                self._draw_cell(x,y,skip_bg=True)
        if self.show_grid.get():
            self._draw_grid()
        self._update_status()

    def _draw_checkerboard(self):
        cw, ch = self._canvas_size()
        c1, c2 = "#c8c8c8", "#a0a0a0"
        s = max(4, self.cell//2)
        for yy in range(0, ch, s):
            for xx in range(0, cw, s):
                color = c1 if ((xx//s + yy//s) % 2)==0 else c2
                self.canvas.create_rectangle(xx,yy,xx+s,yy+s, outline="", fill=color, tags=("bg",))

    def _draw_grid(self):
        cw, ch = self._canvas_size()
        for x in range(0, cw, self.cell):
            self.canvas.create_line(x,0,x,ch, fill="#444")
        for y in range(0, ch, self.cell):
            self.canvas.create_line(0,y,cw,y, fill="#444")

    def _draw_cell(self, x:int, y:int, skip_bg:bool=False):
        # delete any previous items for this cell
        tag = f"cell-{x}-{y}"
        self.canvas.delete(tag)

        x0, y0 = x*self.cell, y*self.cell
        x1, y1 = x0+self.cell, y0+self.cell

        r,g,b,a = self.model.arr[y,x]
        if a == 0:
            # transparent; checkerboard shows through
            pass
        elif a == 1:
            self.canvas.create_rectangle(x0,y0,x1,y1, outline="", fill='#%02x%02x%02x'% (r,g,b), tags=(tag,))
        elif VISIBLE_ASCII_MIN <= a <= VISIBLE_ASCII_MAX:
            # draw a subtle background so glyph edge is clearer
            self.canvas.create_rectangle(x0,y0,x1,y1, outline="", fill="", tags=(tag,))
            ch = chr(int(a))
            # Fit text in cell
            # Tk font sizing is in points; approximate with pixels
            size = max(6, int(self.cell*0.8))
            font = ("Courier New", size)  # monospace-ish; system fallback if missing
            # center text
            self.canvas.create_text((x0+x1)//2, (y0+y1)//2, text=ch,
                                    font=font, fill='#%02x%02x%02x'% (r,g,b),
                                    tags=(tag,))
        else:
            # invalid: draw red X
            self.canvas.create_rectangle(x0,y0,x1,y1, outline="#ff0000", width=max(1, self.cell//8), tags=(tag,))
            self.canvas.create_line(x0,y0,x1,y1, fill="#ff0000", width=max(1, self.cell//8), tags=(tag,))
            self.canvas.create_line(x1,y0,x0,y1, fill="#ff0000", width=max(1, self.cell//8), tags=(tag,))

    def _update_color_preview(self):
        self.color_preview.delete("all")
        self.color_preview.create_rectangle(0,0,24,24, fill='#%02x%02x%02x'% self.current_color, outline="#444")

    def _update_status(self, pos:Optional[Tuple[int,int]]=None):
        mode = self.mode.get()
        color = '#%02x%02x%02x' % self.current_color
        char_info = f"char='{self.last_char}' (alpha={ord(self.last_char)})"
        coord = ""
        if pos:
            x,y = pos
            coord = f" | cell=({x},{y})"
            r,g,b,a = self.model.arr[y,x]
            coord += f" | RGBA=({r},{g},{b},{a})"
        self.status.set(f"Mode: {mode} | Color: {color} | {char_info} | Size: {self.model.w}x{self.model.h}{coord}")

    def _flash_status(self, text:str):
        self.status.set(text)
        self.after(1500, self._update_status)

# ---------- Main ----------
def main():
    # optional CLI for starting a specific file (width/height)
    # usage: python atlas_paint.py [path] [width] [height]
    app = AtlasPaintApp()
    if len(sys.argv) >= 2 and os.path.exists(sys.argv[1]):
        path = sys.argv[1]
        try:
            w = int(sys.argv[2]) if len(sys.argv) >= 3 else DEFAULT_W
            h = int(sys.argv[3]) if len(sys.argv) >= 4 else DEFAULT_H
            app.model.load_raw(path, w, h)
            app.file_path = path
            app._redraw_all()
        except Exception as e:
            messagebox.showerror("Startup open failed", str(e))
    app.mainloop()

if __name__ == "__main__":
    # Dependencies: pip install pillow numpy
    main()
