(function () {
  'use strict';
  const { api, esc, toast } = App;
  const rows = document.getElementById('userRows');
  const form = document.getElementById('userForm');
  async function load() {
    const users = await api('GET', '/api/users');
    rows.innerHTML = users.map((u) => `<tr>
      <td class="fw-semibold">${esc(u.username)}</td>
      <td><select class="form-select form-select-sm" data-role="${u.id}" style="width:auto">${['ADMIN', 'OPERATOR', 'DISPLAY'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td><span class="badge text-bg-${u.status === 'ACTIVE' ? 'success' : 'secondary'}">${u.status}</span></td>
      <td class="small">${new Date(u.createdAt).toLocaleString()}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-dark" data-pw="${u.id}">Reset password</button>
        <button class="btn btn-sm btn-outline-${u.status === 'ACTIVE' ? 'danger' : 'success'}" data-toggle="${u.id}" data-status="${u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}">${u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', { username: form.username.value, password: form.password.value, role: form.role.value });
      toast('User added.'); form.reset(); load();
    } catch (err) { toast(err.message, 'danger'); }
  });
  rows.addEventListener('change', async (e) => {
    const id = e.target.dataset.role; if (!id) return;
    try { await api('PATCH', `/api/users/${id}`, { role: e.target.value }); toast('Role updated.'); } catch (err) { toast(err.message, 'danger'); load(); }
  });
  rows.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.toggle) { await api('PATCH', `/api/users/${b.dataset.toggle}`, { status: b.dataset.status }); toast('User updated.'); }
      if (b.dataset.pw) {
        const r = await App.prompt({ title: 'Reset password', label: 'New password (at least 6 characters)', inputType: 'password', confirmText: 'Set password' });
        if (!r) return;
        await api('PATCH', `/api/users/${b.dataset.pw}`, { password: r.value }); toast('Password changed.');
      }
      load();
    } catch (err) { toast(err.message, 'danger'); }
  });
  load().catch((e) => toast(e.message, 'danger'));
})();
