# Example

To get models for the example, run:
    
```bash
git clone --depth 1 --branch main --single-branch https://github.com/mozilla/firefox-translations-models/
mkdir models
cp -rf firefox-translations-models/registry.json models
cp -rf firefox-translations-models/models/prod/* models
cp -rf firefox-translations-models/models/dev/* models
gunzip models/*/*
```