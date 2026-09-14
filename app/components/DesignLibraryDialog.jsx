'use client';

import { useEffect, useMemo, useState } from 'react';

function dimensions(design) {
  return design.widthPx && design.heightPx ? `${design.widthPx} × ${design.heightPx} px` : 'Dimensions not available';
}

function defaultDesignForm() {
  return { id: '', name: '', categoryId: '', tags: '', visible: true };
}

export default function DesignLibraryDialog({ open, auth, onImport, busy, importMessage, onDragStart, onDragEnd }) {
  const { accessToken, signedIn, canManageLibrary, mode } = auth;
  const localPreview = mode === 'local';
  const [library, setLibrary] = useState({ categories: [], designs: [], canManageLibrary: false });
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [designForm, setDesignForm] = useState(defaultDesignForm);
  const [categoryName, setCategoryName] = useState('');
  const [categoryDrafts, setCategoryDrafts] = useState({});
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [imageSizes, setImageSizes] = useState({});

  useEffect(() => {
    setLibrary({ categories: [], designs: [], canManageLibrary: false });
    setPreview(null);
    setIncludeHidden(false);
    setDesignForm(defaultDesignForm());
    setFile(null);
  }, [accessToken, signedIn, mode, canManageLibrary]);

  async function request(path, options = {}) {
    if (!auth.current().signedIn) throw new Error('Please sign in to continue.');
    if (localPreview) throw new Error('The shared library catalog is unavailable in this local preview.');
    const response = await fetch(path, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401 && data.code === 'invalid_session') auth.signOut();
      throw new Error(data.configured === false ? 'The shared library is temporarily unavailable. Please try again later.' : data.message || 'Design Library request failed.');
    }
    return data;
  }

  async function loadLibrary() {
    if (!signedIn) return;
    if (localPreview) {
      setLibrary({ categories: [], designs: [], canManageLibrary });
      setStatus('You are signed in. The shared design catalog is unavailable in this local preview. Your current sheet and local uploads are ready to use.');
      setLoading(false);
      return;
    }
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await request(`/api/library?includeHidden=${includeHidden ? 'true' : 'false'}`);
      const current = auth.current();
      if (!current.signedIn || current.accessToken !== accessToken || current.mode !== mode) return;
      setLibrary({ categories: data.categories || [], designs: data.designs || [], canManageLibrary: canManageLibrary && data.canManageLibrary === true });
      setCategoryDrafts(Object.fromEntries((data.categories || []).map((category) => [category.id, category.name])));
      setStatus('');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) loadLibrary();
  }, [open, includeHidden, accessToken, signedIn, canManageLibrary, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const designs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return library.designs.filter((design) => {
      const categoryMatches = !categoryId || design.categoryId === categoryId;
      const text = `${design.name} ${design.category} ${(design.tags || []).join(' ')}`.toLowerCase();
      return categoryMatches && (!needle || text.includes(needle));
    });
  }, [library.designs, query, categoryId]);

  if (!open || !signedIn) return null;
  const managementVisible = canManageLibrary && library.canManageLibrary;

  async function createCategory(event) {
    event.preventDefault();
    try {
      await request('/api/library/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: categoryName }) });
      setCategoryName('');
      await loadLibrary();
      setStatus('Category created.');
    } catch (error) { setStatus(error.message); }
  }

  async function updateCategory(id) {
    try {
      await request(`/api/library/categories/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: categoryDrafts[id] }) });
      await loadLibrary();
      setStatus('Category updated.');
    } catch (error) { setStatus(error.message); }
  }

  async function deleteCategory(id) {
    if (!window.confirm('Delete this category? Designs in it will become uncategorized.')) return;
    try {
      await request(`/api/library/categories/${id}`, { method: 'DELETE' });
      if (categoryId === id) setCategoryId('');
      await loadLibrary();
      setStatus('Category deleted.');
    } catch (error) { setStatus(error.message); }
  }

  async function saveDesign(event) {
    event.preventDefault();
    try {
      if (designForm.id) {
        await request(`/api/library/designs/${designForm.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(designForm),
        });
        setStatus('Design details updated.');
      } else {
        if (!file) throw new Error('Choose a PNG to upload.');
        const imageDimensions = await new Promise((resolve, reject) => {
          const image = new Image();
          const url = URL.createObjectURL(file);
          image.onload = () => { URL.revokeObjectURL(url); resolve({ widthPx: image.naturalWidth, heightPx: image.naturalHeight }); };
          image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the PNG dimensions.')); };
          image.src = url;
        });
        const form = new FormData();
        form.append('file', file);
        form.append('name', designForm.name || file.name.replace(/\.png$/i, ''));
        form.append('categoryId', designForm.categoryId);
        form.append('tags', designForm.tags);
        form.append('visible', String(designForm.visible));
        form.append('widthPx', String(imageDimensions.widthPx));
        form.append('heightPx', String(imageDimensions.heightPx));
        await request('/api/library/designs', { method: 'POST', body: form });
        setStatus('PNG added to the library.');
      }
      setDesignForm(defaultDesignForm());
      setFile(null);
      await loadLibrary();
    } catch (error) { setStatus(error.message); }
  }

  async function deleteDesign(design) {
    if (!window.confirm(`Remove “${design.name}” from the library?`)) return;
    try {
      await request(`/api/library/designs/${design.id}`, { method: 'DELETE' });
      if (designForm.id === design.id) setDesignForm(defaultDesignForm());
      await loadLibrary();
      setStatus('Design removed.');
    } catch (error) { setStatus(error.message); }
  }

  async function importDesign(design) {
    try {
      await onImport(design);
    } catch (error) {
      setStatus(error.message || 'Unable to add this design to the builder.');
    }
  }

  return (
    <section id="workspace-library" className="workspace-library" aria-label="Browse designs">
      <div className="library-panel">
        <header className="library-header">
          <div>
            <p className="access-kicker">THE DESIGN EDIT</p>
            <h2 id="library-title">Find your next print.</h2>
            <p>Drag onto your sheet, or add with a click.</p>
          </div>
        </header>

        <div className="library-toolbar">
          <label>
            Search designs or tags
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. flowers, logo" />
          </label>
          <label>
            Category
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">All categories</option>
              {library.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          {managementVisible && <label className="library-checkbox"><input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} /> Show hidden</label>}
        </div>

        {status && <p className="library-status" role="status">{status}</p>}
        {importMessage && <p className="library-status import-status" role="status" aria-live="polite">{importMessage}</p>}

        <div className={managementVisible ? 'library-content with-admin' : 'library-content'}>
          {preview && <div className="library-preview">
            <button type="button" onClick={() => setPreview(null)} aria-label="Close design preview">×</button>
            <img src={preview.imageUrl} alt={preview.name} />
            <strong>{preview.name}</strong><small>{dimensions(preview)} · transparent PNG</small>
          </div>}
          <div>
            <p className="library-count">{designs.length} designs <span>CURATED FOR YOUR NEXT CREATION</span></p>
            {loading ? <p className="library-empty">Loading library…</p> : designs.length === 0 ? <p className="library-empty">No matching designs yet.</p> : (
              <div className="library-grid">
                {designs.map((design) => (
                  <article className={`library-design${design.visible ? '' : ' is-hidden'}`} key={design.id}>
                    <button type="button" className="library-thumb" aria-label={`Preview ${design.name}`} draggable={!busy && design.visible && Boolean(design.widthPx || imageSizes[design.id])}
                      onClick={() => setPreview(design)} onDragStart={(event) => onDragStart(event, { ...design, ...(design.widthPx ? {} : imageSizes[design.id]) })} onDragEnd={onDragEnd}>
                      <img src={design.thumbnailUrl || design.imageUrl} alt="" draggable="false" onLoad={(event) => {
                        if (!design.thumbnailUrl) setImageSizes(current => ({ ...current, [design.id]: { widthPx: event.target.naturalWidth, heightPx: event.target.naturalHeight } }));
                      }} /><span className="library-preview-hint">↗ Preview</span>
                    </button>
                    <div className="library-design-copy">
                      <strong>{design.name}</strong>
                      <span>{design.category}</span>
                      <small>{dimensions(design)}</small>
                      {design.tags?.length > 0 && <small className="library-tags">{design.tags.join(' · ')}</small>}
                    </div>
                    <div className="library-card-actions">
                      <button type="button" onClick={() => importDesign(design)} disabled={busy || !design.visible}>+ Add to sheet</button>
                      {managementVisible && <>
                        <button type="button" className="secondary" onClick={() => { setDesignForm({ id: design.id, name: design.name, categoryId: design.categoryId, tags: design.tags.join(', '), visible: design.visible }); document.querySelector('.library-management').open = true; document.querySelector('.library-admin').scrollIntoView({ block: 'start' }); }}>Edit</button>
                        <button type="button" className="danger" onClick={() => deleteDesign(design)}>Remove</button>
                      </>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          {managementVisible && (
            <details className="library-management"><summary>Manage library <span>ADMIN</span></summary>
            <aside className="library-admin">
              {localPreview && <p className="modal-copy">Library management becomes available when the shared catalog is connected.</p>}
              <fieldset className="library-admin-fields" disabled={localPreview}>
              <h3>Library management</h3>
              <form className="library-form" onSubmit={saveDesign}>
                <h4>{designForm.id ? 'Edit design' : 'Upload PNG'}</h4>
                {!designForm.id && <label>Transparent PNG<input type="file" accept="image/png" onChange={(event) => setFile(event.target.files?.[0] || null)} required /></label>}
                <label>Name<input value={designForm.name} onChange={(event) => setDesignForm({ ...designForm, name: event.target.value })} placeholder={file?.name?.replace(/\.png$/i, '') || 'Design name'} /></label>
                <label>Category<select value={designForm.categoryId} onChange={(event) => setDesignForm({ ...designForm, categoryId: event.target.value })}><option value="">Uncategorized</option>{library.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                <label>Tags<input value={designForm.tags} onChange={(event) => setDesignForm({ ...designForm, tags: event.target.value })} placeholder="floral, summer, logo" /></label>
                <label className="library-checkbox"><input type="checkbox" checked={designForm.visible} onChange={(event) => setDesignForm({ ...designForm, visible: event.target.checked })} /> Visible to signed-in users</label>
                <div className="library-form-actions"><button type="submit">{designForm.id ? 'Save changes' : 'Upload design'}</button>{designForm.id && <button type="button" className="secondary" onClick={() => setDesignForm(defaultDesignForm())}>Cancel</button>}</div>
              </form>
              <form className="library-form library-categories" onSubmit={createCategory}>
                <h4>Categories</h4>
                <label>New category<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /></label>
                <button type="submit">Add category</button>
                {library.categories.map((category) => <div className="category-edit" key={category.id}><input aria-label={`${category.name} category`} value={categoryDrafts[category.id] || ''} onChange={(event) => setCategoryDrafts({ ...categoryDrafts, [category.id]: event.target.value })} /><button type="button" className="secondary" onClick={() => updateCategory(category.id)}>Save</button><button type="button" className="danger" onClick={() => deleteCategory(category.id)}>Delete</button></div>)}
              </form>
              </fieldset>
            </aside>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
