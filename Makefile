UUID = benthicbloom@quinta0.github.io
EXTENSIONS_DIR = $(HOME)/.local/share/gnome-shell/extensions
INSTALL_DIR = $(EXTENSIONS_DIR)/$(UUID)
SCHEMA_DIR = schemas

.PHONY: all schemas build install uninstall pack clean

all: build

schemas:
	glib-compile-schemas $(SCHEMA_DIR)

build: schemas

install: build
	mkdir -p $(INSTALL_DIR)/lib $(INSTALL_DIR)/schemas
	cp extension.js prefs.js metadata.json stylesheet.css $(INSTALL_DIR)/
	cp lib/*.js $(INSTALL_DIR)/lib/
	cp $(SCHEMA_DIR)/*.xml $(SCHEMA_DIR)/gschemas.compiled $(INSTALL_DIR)/schemas/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Reload GNOME Shell (Alt+F2, r, Enter on X11; log out/in on Wayland), then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

pack: schemas
	gnome-extensions pack --force --extra-source=lib -o dist .

clean:
	rm -f $(SCHEMA_DIR)/gschemas.compiled
	rm -rf dist
