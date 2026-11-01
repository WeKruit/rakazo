"""Offline verification for this public specification bundle, not product/business acceptance."""
from pathlib import Path
import json,math,re,subprocess,tempfile,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent
entries=json.loads((ROOT/'design-details/manifest.json').read_text())
assert len(entries)==99
assert {x['id'] for x in entries}=={p.stem for p in (ROOT/'design-details/states').glob('*.json')}
count=0
for row in entries:
 for key in ('json','ax','screenshot'):assert (ROOT/'design-details'/row[key]).is_file(),row
 d=json.loads((ROOT/'design-details'/row['json']).read_text());assert d['id']==row['id']
 assert d['url']=='https://example.invalid/reference'
 assert len({e['index'] for e in d['elements']})==len(d['elements'])
 for n in d['elements']:
  r=n['rect'];assert all(math.isfinite(r[k]) for k in ('x','y','width','height'))
  assert r['width']>=0 and r['height']>=0
 svg=ET.parse(ROOT/'design-details'/row['screenshot']).getroot()
 assert (float(svg.attrib['width']),float(svg.attrib['height']))==(d['window']['innerWidth'],d['window']['innerHeight'])
 assert len(row['privateCaptureSha256'])==64
 count+=len(d['elements'])
links=0
for p in ROOT.rglob('*.md'):
 for href in re.findall(r'\]\(([^)]+)\)',p.read_text()):
  if '://' in href or href.startswith('#'):continue
  href=href.split('#')[0].strip('<>')
  assert (p.parent/href).exists(),(p.relative_to(ROOT),href)
  links+=1
for p in ROOT.rglob('*.html'):
 s=p.read_text()
 for href in re.findall(r'(?:href|src)="([^"]+)"',s):
  if '://' not in href and not href.startswith('#'):assert (p.parent/href.split('#')[0]).exists(),(p,href)
 for js in re.findall(r'<script>([\s\S]*?)</script>',s):
  with tempfile.NamedTemporaryFile('w',suffix='.js') as f:
   f.write(js);f.flush();subprocess.run(['node','--check',f.name],check=True,capture_output=True)
# Publish only diagrams and generic glyphs: no original screenshots or personal photos.
assert not list(ROOT.rglob('*.jpg'))
assert not list(ROOT.rglob('*.jpeg'))
allowed_png={'juicebox-linkedin-rendered.png','juicebox-email-rendered.png','juicebox-github-rendered.png'}
assert all(p.name in allowed_png for p in ROOT.rglob('*.png'))
for p in ROOT.rglob('*'):
 if not p.is_file() or p.suffix=='.png' or p.name=='verify.py':continue
 s=p.read_text()
 assert not re.search(r'/Users/|/var/folders/|front\.openjobs|lh3\.googleusercontent|[?&]token=|Bearer [A-Za-z0-9]|sk-[A-Za-z0-9]{16}',s),p
 for email in re.findall(r'[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}',s):assert email.endswith('@example.invalid'),(p,email)
 assert not re.search(r'(?i)Max Dowling|Anand Koshy|Kirby Slater|Khalil Elkarake|Gino Lacson|Admin WeKruit|unitpulse\.ai|seq_2c265',s),p
result={'states':len(entries),'component_samples':count,'local_markdown_links':links,'geometry_and_diagram_dimensions':'passed','viewer_js_syntax':'passed','publish_privacy_checks':'passed','live_database_verified':False,'business_e2e_verified':False}
(ROOT/'validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
