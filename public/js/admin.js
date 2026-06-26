// ==========================================================================
// Central Admin Portal Client Script
// ==========================================================================

const API_BASE = '/api';

// Admin State
let state = {
  currentUser: null,
  config: null,
  departments: [],
  courses: [],
  faculty: [],
  batchDeptMappings: [],
  batchConfig: { programTypes: {}, fundingTypes: {}, yearSemMap: {} },
  groupMappings: {},
  allBatches: [],
  currentTab: 'tab-admin-dashboard',
  selectedDataSubtab: 'subtab-courses'
};

document.addEventListener('DOMContentLoaded', () => {
  initAdmin();
});

let isAdminVerified = false;
let pendingRevealDept = null;

function openAdminVerifyModal() {
  const modal = document.getElementById('modal-verify-admin');
  const input = document.getElementById('verify-admin-pwd-input');
  const err = document.getElementById('verify-admin-error');
  
  if (input) input.value = '';
  if (err) err.classList.add('hidden');
  if (modal) modal.classList.remove('hidden');
  if (input) input.focus();
}

function closeAdminVerifyModal() {
  const modal = document.getElementById('modal-verify-admin');
  if (modal) modal.classList.add('hidden');
  pendingRevealDept = null;
}

function bindCustomModals() {
  // Return comments modal
  const btnSubmitReturn = document.getElementById('btn-submit-return-comments');
  const btnCancelReturn = document.getElementById('btn-cancel-return-comments');
  const returnInput = document.getElementById('return-comments-input');
  const modalReturn = document.getElementById('modal-return-comments');

  if (btnCancelReturn) {
    btnCancelReturn.addEventListener('click', () => {
      if (modalReturn) modalReturn.classList.add('hidden');
    });
  }

  if (btnSubmitReturn) {
    btnSubmitReturn.addEventListener('click', async () => {
      const deptName = modalReturn.getAttribute('data-target-dept');
      const comments = returnInput.value.trim();
      const err = document.getElementById('return-comments-error');
      
      if (!comments) {
        if (err) {
          err.textContent = 'Please enter return comments/instructions.';
          err.classList.remove('hidden');
        }
        return;
      }
      
      if (modalReturn) modalReturn.classList.add('hidden');
      await window.updateSubStatus(deptName, 'Returned for Changes', comments);
    });
  }

  // Admin verify modal
  const btnSubmitVerify = document.getElementById('btn-submit-verify-admin');
  const btnCancelVerify = document.getElementById('btn-cancel-verify-admin');
  const verifyInput = document.getElementById('verify-admin-pwd-input');

  if (btnCancelVerify) {
    btnCancelVerify.addEventListener('click', () => {
      closeAdminVerifyModal();
    });
  }

  const handleVerifySubmit = async () => {
    const password = verifyInput.value;
    const err = document.getElementById('verify-admin-error');
    if (err) err.classList.add('hidden');
    
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password })
      });
      const result = await res.json();
      if (res.ok) {
        isAdminVerified = true;
        closeAdminVerifyModal();
        showModalAlert('Access Approved', 'Admin credentials verified. Passcodes unlocked.', 'success');
        if (pendingRevealDept) {
          const deptName = pendingRevealDept;
          pendingRevealDept = null;
          const pwdInput = document.getElementById(`pwd-${deptName}`);
          const eyeIcon = document.getElementById(`eye-${deptName}`);
          if (pwdInput && eyeIcon) {
            pwdInput.type = 'text';
            eyeIcon.classList.replace('fa-eye', 'fa-eye-slash');
          }
        }
      } else {
        if (err) {
          err.textContent = result.message || 'Incorrect password.';
          err.classList.remove('hidden');
        }
      }
    } catch (e) {
      if (err) {
        err.textContent = 'Connection error.';
        err.classList.remove('hidden');
      }
    }
  };

  if (btnSubmitVerify) {
    btnSubmitVerify.addEventListener('click', handleVerifySubmit);
  }
  if (verifyInput) {
    verifyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleVerifySubmit();
      }
    });
  }

  // Course Edit Modal close
  document.getElementById('btn-close-course-modal').addEventListener('click', () => {
    document.getElementById('modal-edit-course').classList.add('hidden');
  });

  // Course Edit Modal save
  document.getElementById('btn-save-course-details').addEventListener('click', async () => {
    const code = document.getElementById('edit-course-code').value;
    const name = document.getElementById('edit-course-name').value.trim();
    const alias = document.getElementById('edit-course-alias').value.trim();

    if (!name) {
      showModalAlert('Error', 'Course Name is required.', 'danger');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/admin/courses/${encodeURIComponent(code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, alias })
      });
      const result = await res.json();
      if (res.ok) {
        document.getElementById('modal-edit-course').classList.add('hidden');
        showModalAlert('Success', 'Course details updated successfully.', 'success');
        await fetchGlobalData();
        renderInspectRecords();
      } else {
        showModalAlert('Error', result.message || 'Failed to update course.', 'danger');
      }
    } catch (e) {
      showModalAlert('Error', 'Connection error.', 'danger');
    }
  });

  // Batch-Dept Mapping Modal close
  document.getElementById('btn-close-batch-dept-modal').addEventListener('click', () => {
    document.getElementById('modal-batch-dept').classList.add('hidden');
  });

  // Batch-Dept Mapping Modal save
  document.getElementById('btn-save-batch-dept').addEventListener('click', async () => {
    const codeInput = document.getElementById('batch-dept-code-input');
    const nameInput = document.getElementById('batch-dept-name-input');
    const code = codeInput.value.trim().toUpperCase();
    const deptName = nameInput.value.trim().toUpperCase();

    if (!code || !deptName) {
      showModalAlert('Error', 'Both Batch Code and Department Name are required.', 'danger');
      return;
    }

    const isEdit = codeInput.disabled;

    try {
      let res;
      if (isEdit) {
        res = await fetch(`${API_BASE}/admin/batch-dept-mappings/${encodeURIComponent(code)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deptName })
        });
      } else {
        res = await fetch(`${API_BASE}/admin/batch-dept-mappings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deptName })
        });
      }

      const result = await res.json();
      if (res.ok) {
        document.getElementById('modal-batch-dept').classList.add('hidden');
        showModalAlert('Success', isEdit ? 'Mapping updated successfully.' : 'Mapping added successfully.', 'success');
        await fetchGlobalData();
        renderBatchDeptMappings();
      } else {
        showModalAlert('Error', result.message || 'Failed to save mapping.', 'danger');
      }
    } catch (e) {
      showModalAlert('Error', 'Connection error.', 'danger');
    }
  });

  // Add Batch-Dept button
  const btnAddBatchDept = document.getElementById('btn-add-batch-dept');
  if (btnAddBatchDept) {
    btnAddBatchDept.addEventListener('click', () => {
      document.getElementById('batch-dept-modal-title').textContent = 'Add New Mapping';
      const codeInput = document.getElementById('batch-dept-code-input');
      codeInput.value = '';
      codeInput.disabled = false;
      document.getElementById('batch-dept-name-input').value = '';
      document.getElementById('modal-batch-dept').classList.remove('hidden');
    });
  }

  // Group Mapping Modal close
  document.getElementById('btn-close-group-mapping-modal').addEventListener('click', () => {
    document.getElementById('modal-group-mapping').classList.add('hidden');
  });

  // Group Mapping Modal save
  document.getElementById('btn-save-group-mapping').addEventListener('click', async () => {
    const courseCode = document.getElementById('mapping-course-code').value;
    // Read from the modal's live data attribute (set by openGroupMappingModal)
    const modal = document.getElementById('modal-group-mapping');
    let batches = [];
    try { batches = JSON.parse(modal.dataset.currentMapped || '[]'); } catch(e) { batches = []; }

    try {
      const res = await fetch(`${API_BASE}/admin/group-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseCode, batches })
      });
      const result = await res.json();
      if (res.ok) {
        document.getElementById('modal-group-mapping').classList.add('hidden');
        showModalAlert('Success', 'Group mappings saved successfully.', 'success');
        await fetchGlobalData();
        renderGroupMappings();
      } else {
        showModalAlert('Error', result.message || 'Failed to save mappings.', 'danger');
      }
    } catch (e) {
      showModalAlert('Error', 'Connection error.', 'danger');
    }
  });

  // Group Mapping Export CSV
  const btnExportGroupMappings = document.getElementById('btn-export-group-mappings');
  if (btnExportGroupMappings) {
    btnExportGroupMappings.addEventListener('click', () => {
      const groupCourses = state.courses.filter(c => c.group && c.group > 0);
      const uniq = [];
      groupCourses.forEach(c => {
        if (!uniq.some(uc => uc.code === c.code)) uniq.push(c);
      });

      if (uniq.length === 0) {
        showModalAlert('No Groups', 'There are no group courses configured in the database to export.', 'info');
        return;
      }

      let csv = "Course Code,Course Name,Group,Batches\n";
      uniq.forEach(c => {
        const baseCode = c.code.replace(/_G\d+$/, '');
        const mapped = (c.mappedBatches || []).join(',');
        const nameEscaped = `"${c.name.replace(/"/g, '""')}"`;
        const batchesEscaped = `"${mapped.replace(/"/g, '""')}"`;
        csv += `${baseCode},${nameEscaped},${c.group},${batchesEscaped}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", `group_batches_export.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // Group Mapping Import file triggers
  const btnTriggerImportGroupMappings = document.getElementById('btn-trigger-import-group-mappings');
  const fileInputGroupMappings = document.getElementById('import-group-mappings-file');

  if (btnTriggerImportGroupMappings && fileInputGroupMappings) {
    btnTriggerImportGroupMappings.addEventListener('click', () => {
      fileInputGroupMappings.click();
    });

    fileInputGroupMappings.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch(`${API_BASE}/import/group-mappings`, {
          method: 'POST',
          body: formData
        });
        const result = await res.json();
        // Clear value so the same file can be selected again
        fileInputGroupMappings.value = '';

        if (res.ok) {
          showModalAlert('Success', result.message || 'Group mappings imported successfully.', 'success');
          await fetchGlobalData();
          renderGroupMappings();
        } else {
          showModalAlert('Error', result.error || 'Failed to import mappings.', 'danger');
        }
      } catch (err) {
        fileInputGroupMappings.value = '';
        showModalAlert('Error', 'Connection error during upload.', 'danger');
      }
    });
  }

  // Save Batch Config button
  const btnSaveBatchConfig = document.getElementById('btn-save-batch-config');
  if (btnSaveBatchConfig) {
    btnSaveBatchConfig.addEventListener('click', async () => {
      const cfg = readBatchConfigFromEditors();
      try {
        const res = await fetch(`${API_BASE}/admin/batch-config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg)
        });
        const result = await res.json();
        if (res.ok) {
          state.batchConfig = cfg;
          // Refresh batches from server
          const bRes = await fetch(`${API_BASE}/batches`);
          state.allBatches = await bRes.json();
          renderBatchPreview();
          showModalAlert('Success', 'Batch configuration saved.', 'success');
        } else {
          showModalAlert('Error', result.message || 'Failed to save config.', 'danger');
        }
      } catch (e) {
        showModalAlert('Error', 'Connection error.', 'danger');
      }
    });
  }
}

async function initAdmin() {
  bindAuthEvents();
  bindSidebarEvents();
  bindConfigEvents();
  bindImportEvents();
  bindSearchEvents();
  bindCustomModals();
  
  // Custom Modal dialog elements
  window.appModal = {
    overlay: document.getElementById('app-modal'),
    icon: document.getElementById('app-modal-icon'),
    title: document.getElementById('app-modal-title'),
    message: document.getElementById('app-modal-message'),
    btnPrimary: document.getElementById('app-modal-btn-primary'),
    btnSecondary: document.getElementById('app-modal-btn-secondary')
  };

  // Restore session
  const savedUser = sessionStorage.getItem('adminUser');
  if (savedUser) {
    state.currentUser = JSON.parse(savedUser);
    document.getElementById('header-user-info').classList.remove('hidden');
    await fetchGlobalData();
    switchView('admin');
    showTab(state.currentTab);
  } else {
    switchView('login');
  }
}

// Custom Modal Alerts Utility (Eliminating browser window alert/confirms)
window.showModalAlert = function(title, message, type = 'info', callback = null) {
  const { overlay, icon, thisTitle = title, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  window.appModal.message.textContent = message;
  
  // Set Icon
  let iconHtml = '<i class="fa-solid fa-circle-info text-primary"></i>';
  if (type === 'success') iconHtml = '<i class="fa-solid fa-circle-check text-success"></i>';
  else if (type === 'warning') iconHtml = '<i class="fa-solid fa-triangle-exclamation text-warning"></i>';
  else if (type === 'danger') iconHtml = '<i class="fa-solid fa-circle-xmark text-danger"></i>';
  window.appModal.icon.innerHTML = iconHtml;
  
  btnSecondary.classList.add('hidden');
  btnPrimary.textContent = "Okay";
  
  // Clean old listeners
  const newBtn = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtn, btnPrimary);
  window.appModal.btnPrimary = newBtn;
  
  window.appModal.btnPrimary.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (callback) callback();
  });
  
  overlay.classList.remove('hidden');
};

window.showModalConfirm = function(title, message, onConfirm) {
  const { overlay, icon, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  window.appModal.message.textContent = message;
  window.appModal.icon.innerHTML = '<i class="fa-solid fa-circle-question text-primary"></i>';
  
  btnSecondary.classList.remove('hidden');
  btnSecondary.textContent = "Cancel";
  btnPrimary.textContent = "Confirm";
  
  // Clone to clean listeners
  const newBtnPrimary = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtnPrimary, btnPrimary);
  window.appModal.btnPrimary = newBtnPrimary;
  
  const newBtnSecondary = btnSecondary.cloneNode(true);
  btnSecondary.parentNode.replaceChild(newBtnSecondary, btnSecondary);
  window.appModal.btnSecondary = newBtnSecondary;
  
  window.appModal.btnPrimary.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (onConfirm) onConfirm();
  });
  
  window.appModal.btnSecondary.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });
  
  overlay.classList.remove('hidden');
};

// Switch top level view
function switchView(viewName) {
  const loginView = document.getElementById('view-login');
  const adminView = document.getElementById('view-admin');
  
  if (viewName === 'admin') {
    adminView.classList.remove('hidden');
    adminView.classList.add('active');
    loginView.classList.add('hidden');
    loginView.classList.remove('active');
  } else {
    loginView.classList.remove('hidden');
    loginView.classList.add('active');
    adminView.classList.add('hidden');
    adminView.classList.remove('active');
  }
}

async function fetchGlobalData() {
  try {
    const token = sessionStorage.getItem('adminToken') || 'admin-token';
    const [configRes, deptsRes, coursesRes, facultyRes, batchDeptsRes, batchCfgRes, groupRes, allBatchesRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/admin/departments`, { headers: { 'Authorization': token } }),
      fetch(`${API_BASE}/courses`),
      fetch(`${API_BASE}/faculty`),
      fetch(`${API_BASE}/admin/batch-dept-mappings`),
      fetch(`${API_BASE}/admin/batch-config`),
      fetch(`${API_BASE}/admin/group-mappings`),
      fetch(`${API_BASE}/batches`)
    ]);

    state.config          = await configRes.json();
    state.departments     = await deptsRes.json();
    state.courses         = await coursesRes.json();
    state.faculty         = await facultyRes.json();
    state.batchDeptMappings = await batchDeptsRes.json();
    state.batchConfig     = await batchCfgRes.json();
    state.groupMappings   = await groupRes.json();
    state.allBatches      = await allBatchesRes.json();

    updateAdminSummary();
  } catch (err) {
    console.error('Failed to load global data:', err);
  }
}

// -------------------------------------------------------------
// Authentication Binds
// -------------------------------------------------------------
function bindAuthEvents() {
  const loginForm = document.getElementById('login-form');
  const pwdInput = document.getElementById('login-password');
  const pwdIcon = document.getElementById('toggle-pwd-icon');
  const logoutBtn = document.getElementById('btn-logout');
  const errBox = document.getElementById('login-error');
  
  pwdIcon.addEventListener('click', () => {
    if (pwdInput.type === 'password') {
      pwdInput.type = 'text';
      pwdIcon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
      pwdInput.type = 'password';
      pwdIcon.classList.replace('fa-eye-slash', 'fa-eye');
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = pwdInput.value;
    errBox.classList.add('hidden');
    
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password })
      });
      
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.message || 'Login failed');
      }
      
      state.currentUser = { role: 'admin' };
      sessionStorage.setItem('adminUser', JSON.stringify(state.currentUser));
      sessionStorage.setItem('adminToken', result.token || 'admin-token');
      document.getElementById('header-user-info').classList.remove('hidden');
      
      await fetchGlobalData();
      switchView('admin');
      showTab('tab-admin-dashboard');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('adminUser');
    state.currentUser = null;
    document.getElementById('header-user-info').classList.add('hidden');
    pwdInput.value = '';
    switchView('login');
  });
}

// -------------------------------------------------------------
// Navigation Sidebar Tabs
// -------------------------------------------------------------
function bindSidebarEvents() {
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const tabId = item.getAttribute('data-tab');
      showTab(tabId);
    });
  });
}

function showTab(tabId) {
  state.currentTab = tabId;
  const panes = document.querySelectorAll('.dashboard-content .tab-pane');
  panes.forEach(pane => {
    if (pane.id === tabId) {
      pane.classList.remove('hidden');
      pane.classList.add('active');
    } else {
      pane.classList.add('hidden');
      pane.classList.remove('active');
    }
  });
  
  if (tabId === 'tab-admin-dashboard') {
    fetchGlobalData();
  } else if (tabId === 'tab-admin-config') {
    renderConfigForm();
  } else if (tabId === 'tab-admin-passwords') {
    renderPasswordTable();
  } else if (tabId === 'tab-admin-data') {
    renderInspectRecords();
  } else if (tabId === 'tab-admin-batch-dept') {
    renderBatchDeptMappings();
    renderBatchConfig();
    renderBatchPreview();
  } else if (tabId === 'tab-admin-group-mappings') {
    renderGroupMappings();
  } else if (tabId === 'tab-admin-workload') {
    renderWorkloadSummary();
  }
}

// -------------------------------------------------------------
// Central Dashboard & Lifecycles
// -------------------------------------------------------------
function updateAdminSummary() {
  if (!state.config) return;
  document.getElementById('summary-year').textContent = state.config.academicYear || '-';
  document.getElementById('summary-sem').textContent = state.config.semesterType || '-';
  
  let approvedCount = 0;
  let submittedCount = 0;
  let incompleteCount = 0;
  
  state.departments.forEach(d => {
    if (d.status === 'Approved') approvedCount++;
    else if (d.status === 'Submitted') submittedCount++;
    else incompleteCount++;
  });
  
  document.getElementById('stat-approved').textContent = approvedCount;
  document.getElementById('stat-submitted').textContent = submittedCount;
  document.getElementById('stat-incomplete').textContent = incompleteCount;
  
  // Render departments table
  const tbody = document.querySelector('#table-admin-depts tbody');
  tbody.innerHTML = '';
  
  state.departments.forEach(d => {
    const tr = document.createElement('tr');
    
    let statusClass = 'recommend-none';
    if (d.status === 'Approved') statusClass = 'badge-info';
    else if (d.status === 'Submitted') statusClass = 'recommend-p';
    else if (d.status === 'Returned for Changes') statusClass = 'recommend-t';
    
    tr.innerHTML = `
      <td><strong>${d.name}</strong></td>
      <td><span class="badge ${statusClass}">${d.status}</span></td>
      <td>
        <span class="text-sm">
          ${d.hasPassword ? '<span class="text-success"><i class="fa-solid fa-lock"></i> Locked</span>' : '<span class="text-danger"><i class="fa-solid fa-unlock"></i> Unlocked</span>'}
        </span>
      </td>
      <td><span class="text-sm text-muted">${d.comments || 'No comments'}</span></td>
      <td>
        <div class="flex-row gap-2">
          <button class="btn btn-outline btn-xs" onclick="previewDeptTimetable('${d.name}')"><i class="fa-solid fa-eye"></i> View</button>
          ${d.status === 'Submitted' ? `
            <button class="btn btn-primary btn-xs" onclick="updateSubStatus('${d.name}', 'Approved')"><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn-outline btn-xs btn-danger" onclick="promptReturnDept('${d.name}')"><i class="fa-solid fa-rotate-left"></i> Return</button>
          ` : ''}
          ${d.status === 'Approved' ? `
            <button class="btn btn-outline btn-xs" onclick="updateSubStatus('${d.name}', 'Draft')"><i class="fa-solid fa-undo"></i> Revert to Draft</button>
          ` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.previewDeptTimetable = function(deptName) {
  openTimetablePrintModal(deptName);
};

window.updateSubStatus = async function(deptName, status, comments = '') {
  try {
    const res = await fetch(`${API_BASE}/submissions/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentName: deptName, status, comments })
    });
    if (res.ok) {
      showModalAlert('Success', `Workflow status updated to ${status} for ${deptName}`, 'success');
      await fetchGlobalData();
    } else {
      const err = await res.json();
      showModalAlert('Error', 'Error updating status: ' + err.message, 'danger');
    }
  } catch (err) {
    console.error(err);
  }
};

window.promptReturnDept = function(deptName) {
  const modal = document.getElementById('modal-return-comments');
  const input = document.getElementById('return-comments-input');
  const err = document.getElementById('return-comments-error');
  
  if (input) input.value = '';
  if (err) err.classList.add('hidden');
  if (modal) {
    modal.setAttribute('data-target-dept', deptName);
    modal.classList.remove('hidden');
  }
  if (input) input.focus();
};

// Config Settings Form
function renderConfigForm() {
  document.getElementById('config-year').value = state.config.academicYear;
  document.getElementById('config-sem-type').value = state.config.semesterType;
  
  const container = document.getElementById('semester-labels-container');
  container.innerHTML = '';
  
  Object.keys(state.config.semesterLabels).forEach(sem => {
    const div = document.createElement('div');
    div.className = 'form-group flex-row gap-2 mt-2';
    div.innerHTML = `
      <span class="badge badge-info" style="min-width: 60px;">Sem ${sem}</span>
      <i class="fa-solid fa-arrow-right text-muted"></i>
      <input type="text" class="form-control sem-mapping-input" data-sem="${sem}" value="${state.config.semesterLabels[sem]}" style="max-width: 200px;">
    `;
    container.appendChild(div);
  });
}

function bindConfigEvents() {
  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const academicYear = document.getElementById('config-year').value;
    const semesterType = document.getElementById('config-sem-type').value;
    
    const semesterLabels = {};
    document.querySelectorAll('.sem-mapping-input').forEach(input => {
      const sem = input.getAttribute('data-sem');
      semesterLabels[sem] = input.value.trim();
    });
    
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ academicYear, semesterType, semesterLabels })
      });
      if (res.ok) {
        showModalAlert('Success', 'Academic configuration updated.', 'success');
        await fetchGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Clear Database button and confirmation modal bindings
  const btnClearDb = document.getElementById('btn-clear-db');
  const modalClearDb = document.getElementById('modal-clear-db-confirm');
  const clearDbInput = document.getElementById('clear-db-confirm-input');
  const btnConfirmClearDb = document.getElementById('btn-confirm-clear-db');
  const btnCancelClearDb = document.getElementById('btn-cancel-clear-db');

  if (btnClearDb) {
    btnClearDb.addEventListener('click', () => {
      clearDbInput.value = '';
      btnConfirmClearDb.disabled = true;
      modalClearDb.classList.remove('hidden');
    });
  }

  if (clearDbInput) {
    clearDbInput.addEventListener('input', (e) => {
      if (e.target.value.trim().toUpperCase() === 'CLEAR') {
        btnConfirmClearDb.disabled = false;
      } else {
        btnConfirmClearDb.disabled = true;
      }
    });
  }

  if (btnCancelClearDb) {
    btnCancelClearDb.addEventListener('click', () => {
      modalClearDb.classList.add('hidden');
    });
  }

  if (btnConfirmClearDb) {
    btnConfirmClearDb.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/clear-database`, {
          method: 'POST'
        });
        if (res.ok) {
          modalClearDb.classList.add('hidden');
          showModalAlert('Database Reset', 'The database has been successfully cleared.', 'success');
          await fetchGlobalData();
          showTab('tab-admin-dashboard');
        } else {
          const err = await res.json();
          showModalAlert('Error', 'Failed to clear database: ' + err.message, 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'An error occurred while clearing the database.', 'danger');
      }
    });
  }
}

// Passwords Editor
function renderPasswordTable() {
  const tbody = document.querySelector('#table-dept-passwords tbody');
  tbody.innerHTML = '';
  
  state.departments.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${d.name}</strong></td>
      <td>
        <div class="password-input-wrapper" style="max-width: 250px;">
          <input type="password" class="form-control dept-pwd-input" id="pwd-${d.name}" value="${d.passcode || ''}" placeholder="Enter passcode" autocomplete="off">
          <i class="fa-solid fa-eye toggle-password" id="eye-${d.name}" onclick="toggleDeptPasscodeVisibility('${d.name}')"></i>
        </div>
      </td>
      <td>
        <button class="btn btn-primary" onclick="saveDeptPassword('${d.name}')"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.toggleDeptPasscodeVisibility = function(deptName) {
  const pwdInput = document.getElementById(`pwd-${deptName}`);
  const eyeIcon = document.getElementById(`eye-${deptName}`);
  
  if (!pwdInput || !eyeIcon) return;
  
  if (pwdInput.type === 'text') {
    pwdInput.type = 'password';
    eyeIcon.classList.replace('fa-eye-slash', 'fa-eye');
  } else {
    if (isAdminVerified) {
      pwdInput.type = 'text';
      eyeIcon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
      pendingRevealDept = deptName;
      openAdminVerifyModal();
    }
  }
};

window.saveDeptPassword = async function(deptName) {
  const pwdInput = document.getElementById(`pwd-${deptName}`);
  const password = pwdInput.value.trim();
  if (!password) {
    showModalAlert('Warning', 'Password field cannot be empty.', 'warning');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/departments/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: deptName, password })
    });
    if (res.ok) {
      showModalAlert('Success', `Sign-in password saved for department ${deptName}.`, 'success');
      await fetchGlobalData();
      renderPasswordTable();
    } else {
      const err = await res.json();
      showModalAlert('Error', err.message || 'Failed to save passcode.', 'danger');
    }
  } catch (err) {
    console.error(err);
  }
};

// -------------------------------------------------------------
// Excel Uploader Events
// -------------------------------------------------------------
function bindImportEvents() {
  document.querySelectorAll('.btn-file-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).click();
    });
  });

  // Course structure import
  document.getElementById('import-courses-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const status = document.getElementById('courses-upload-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing course sheet...';
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const res = await fetch(`${API_BASE}/import/courses`, {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (res.ok) {
        status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> ${result.message}</span>`;
        showModalAlert('Import Success', result.message, 'success');
        await fetchGlobalData();
        renderImportReport(result.warnings || []);
      } else {
        status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${result.error}</span>`;
        showModalAlert('Import Error', result.error, 'danger');
      }
    } catch (err) {
      status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Upload failed</span>`;
    }
  });

  // Staff import
  document.getElementById('import-staff-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const status = document.getElementById('staff-upload-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing staff sheet...';
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const res = await fetch(`${API_BASE}/import/staff`, {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (res.ok) {
        status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> ${result.message}</span>`;
        showModalAlert('Import Success', result.message, 'success');
        await fetchGlobalData();
        renderImportReport(result.warnings || []);
      } else {
        status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${result.error}</span>`;
        showModalAlert('Import Error', result.error, 'danger');
      }
    } catch (err) {
      status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Upload failed</span>`;
    }
  });

  // Batch-Dept Mapping import
  document.getElementById('import-batch-dept-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const status = document.getElementById('batch-dept-upload-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing mappings sheet...';

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_BASE}/import/batch-dept-mappings`, {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (res.ok) {
        status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> ${result.message}</span>`;
        showModalAlert('Import Success', result.message, 'success');
        await fetchGlobalData();
      } else {
        status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${result.error}</span>`;
        showModalAlert('Import Error', result.error, 'danger');
      }
    } catch (err) {
      status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Upload failed</span>`;
    }
  });
}

function renderImportReport(warnings) {
  const panel = document.getElementById('import-report-card');
  const list = document.getElementById('import-report-list');
  list.innerHTML = '';
  
  if (warnings.length > 0) {
    warnings.forEach(w => {
      const li = document.createElement('li');
      li.textContent = w;
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

// -------------------------------------------------------------
// Inspect Records (Read-Only Searchable Grid)
// -------------------------------------------------------------
function bindSearchEvents() {
  const searchInput = document.getElementById('data-search-input');
  const deptFilter = document.getElementById('data-select-dept');
  
  searchInput.addEventListener('input', () => renderInspectRecords());
  deptFilter.addEventListener('change', () => renderInspectRecords());

  // Bind sub-tabs toggle
  document.querySelectorAll('.tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedDataSubtab = btn.getAttribute('data-subtab');
      
      document.querySelectorAll('.subtab-pane').forEach(p => {
        if (p.id === state.selectedDataSubtab) p.classList.remove('hidden');
        else p.className = 'subtab-pane hidden';
      });
      renderInspectRecords();
    });
  });
}

function renderInspectRecords() {
  const query = document.getElementById('data-search-input').value.toLowerCase().trim();
  const selectedDept = document.getElementById('data-select-dept').value;

  // Initialize department filter dropdown options
  const deptFilter = document.getElementById('data-select-dept');
  if (deptFilter.options.length <= 1) {
    const deptSet = new Set();
    state.courses.forEach(c => deptSet.add(c.department));
    state.faculty.forEach(f => deptSet.add(f.department));
    Array.from(deptSet).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      deptFilter.appendChild(opt);
    });
  }

  // Filter Courses
  let filteredCourses = state.courses;
  if (selectedDept) {
    filteredCourses = filteredCourses.filter(c => c.department === selectedDept);
  }
  if (query) {
    filteredCourses = filteredCourses.filter(c => 
      c.code.toLowerCase().includes(query) || 
      c.name.toLowerCase().includes(query) || 
      (c.alias && c.alias.toLowerCase().includes(query))
    );
  }

  document.getElementById('count-courses').textContent = filteredCourses.length;

  const coursesTbody = document.querySelector('#table-manage-courses tbody');
  coursesTbody.innerHTML = '';
  filteredCourses.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.code.replace(/_G\d+$/, '')}</strong></td>
      <td>${c.semester}</td>
      <td>${c.category}</td>
      <td>${c.name}</td>
      <td><span class="badge badge-info">${c.alias || '-'}</span></td>
      <td><span class="text-sm text-muted">${c.department}</span></td>
      <td>
        <button class="btn btn-outline btn-sm btn-edit-course" style="padding: 2px 8px;"><i class="fa-solid fa-edit"></i> Edit</button>
      </td>
    `;
    tr.querySelector('.btn-edit-course').addEventListener('click', () => {
      document.getElementById('edit-course-code').value = c.code;
      document.getElementById('edit-course-name').value = c.name;
      document.getElementById('edit-course-alias').value = c.alias || '';
      document.getElementById('modal-edit-course').classList.remove('hidden');
    });
    coursesTbody.appendChild(tr);
  });

  // Filter Faculty
  let filteredFaculty = state.faculty;
  if (selectedDept) {
    filteredFaculty = filteredFaculty.filter(f => f.department === selectedDept);
  }
  if (query) {
    filteredFaculty = filteredFaculty.filter(f => 
      f.name.toLowerCase().includes(query) || 
      f.staffId.toLowerCase().includes(query) || 
      f.code.toLowerCase().includes(query)
    );
  }

  document.getElementById('count-faculty').textContent = filteredFaculty.length;

  const facultyTbody = document.querySelector('#table-manage-faculty tbody');
  facultyTbody.innerHTML = '';
  filteredFaculty.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${f.staffId}</td>
      <td><strong>${f.name}</strong></td>
      <td><span class="fac-pill">${f.code}</span></td>
      <td><span class="text-sm text-muted">${f.department}</span></td>
    `;
    facultyTbody.appendChild(tr);
  });
}

// -------------------------------------------------------------
// Workload Summaries
// -------------------------------------------------------------
async function renderWorkloadSummary() {
  try {
    const res = await fetch(`${API_BASE}/reports/workload`);
    const workloadData = await res.json();
    
    const tbody = document.querySelector('#table-workload-summary tbody');
    tbody.innerHTML = '';
    
    workloadData.forEach(row => {
      const courseKeys = Object.keys(row.workload);
      const groupedWorkload = {};
      courseKeys.forEach(k => {
        const baseKey = k.replace(/-(T|P)$/, '');
        if (!groupedWorkload[baseKey]) {
          groupedWorkload[baseKey] = { theory: 0, practical: 0 };
        }
        groupedWorkload[baseKey].theory += row.workload[k].theory;
        groupedWorkload[baseKey].practical += row.workload[k].practical;
      });

      const coursesInfo = Object.keys(groupedWorkload).map(k => {
        const item = groupedWorkload[k];
        return `<span class="badge badge-info" title="${k}">${k} (T:${item.theory}, P:${item.practical})</span>`;
      }).join(' ');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.staffId}</td>
        <td><strong>${row.name}</strong></td>
        <td><span class="fac-pill">${row.code}</span></td>
        <td>${row.department}</td>
        <td>${coursesInfo || '<span class="text-muted">None</span>'}</td>
        <td><strong class="text-primary">${row.totalHours} hrs</strong></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

// Export workload summary table to CSV
document.getElementById('btn-export-workload-csv').addEventListener('click', () => {
  const table = document.getElementById('table-workload-summary');
  let csv = [];
  const ths = table.querySelectorAll('thead th');
  csv.push(Array.from(ths).map(th => `"${th.textContent}"`).join(','));
  
  const trs = table.querySelectorAll('tbody tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    const rowValues = Array.from(tds).map(td => `"${td.textContent.replace(/[\n\r]+/g, ' ').trim()}"`);
    csv.push(rowValues.join(','));
  });
  
  const csvContent = "data:text/csv;charset=utf-8," + csv.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Global_Faculty_Workload_Report_${state.config.academicYear}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// -------------------------------------------------------------
// Printable Preview Layout Builder
// -------------------------------------------------------------
let activePrintDept = "";

function bindPrintEvents() {
  document.getElementById('btn-close-print-modal').addEventListener('click', () => {
    document.getElementById('modal-print-preview').classList.add('hidden');
  });
  
  document.getElementById('print-mode-select').addEventListener('change', () => {
    buildPrintTimetableHtml(document.getElementById('print-mode-select').value);
  });
  
  document.getElementById('btn-trigger-print').addEventListener('click', () => {
    window.print();
  });
  
  document.getElementById('btn-export-timetable-csv').addEventListener('click', () => {
    exportPrintTimetableToCSV();
  });
}

function openTimetablePrintModal(deptName) {
  activePrintDept = deptName;
  document.getElementById('print-dept-name').textContent = `DEPARTMENT OF ${deptName}`;
  document.getElementById('print-active-sem').textContent = `${state.config.semesterType} SEMESTER`;
  document.getElementById('print-active-year').textContent = state.config.academicYear;
  
  bindPrintEvents();
  buildPrintTimetableHtml('medium');
  document.getElementById('modal-print-preview').classList.remove('hidden');
}

async function buildPrintTimetableHtml(displayMode) {
  const periods = state.config.periods;
  const table = document.getElementById('print-grid-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  thead.innerHTML = `
    <tr>
      <th style="width: 80px;">Day</th>
      <th style="width: 100px; text-align: left;">Class/Semester</th>
      ${periods.map(p => `<th>${p}</th>`).join('')}
    </tr>
  `;

  try {
    const res = await fetch(`${API_BASE}/allocations?department=${activePrintDept}`);
    const allocs = await res.json();
    const deptCourses = state.courses.filter(c => c.department === activePrintDept);
    renderPrintGridRows(deptCourses, allocs, periods, displayMode, tbody);
  } catch (err) {
    console.error(err);
  }
}

function getTimetableRowCategory(course) {
  const semLabel = state.config.semesterLabels[course.semester] || `${course.semester} Sem`;
  if (course.code.toUpperCase().includes('MSC') || course.pathway.toUpperCase().includes('MSC') || course.pathway.toUpperCase().includes('POST GRADUATE')) {
    return semLabel + " MSC";
  }
  if (course.category.toUpperCase().includes('MINOR')) {
    return semLabel + " MINOR";
  }
  return semLabel + " BSC";
}

function renderPrintGridRows(courses, allocations, periods, displayMode, tbody) {
  tbody.innerHTML = '';
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const weekdayShort = { "MONDAY": "MON", "TUESDAY": "TUES", "WEDNESDAY": "WED", "THURSDAY": "THUR", "FRIDAY": "FRI" };

  weekdays.forEach(day => {
    const categoriesMap = {};
    courses.forEach(c => {
      const cat = getTimetableRowCategory(c);
      if (!categoriesMap[cat]) categoriesMap[cat] = [];
      categoriesMap[cat].push(c);
    });

    const categories = Object.keys(categoriesMap).sort((a, b) => {
      const getPriority = (x) => {
        if (x.includes("MSC")) return 1;
        if (x.includes("BSC")) return 2;
        if (x.includes("MINOR")) return 3;
        return 4;
      };
      return getPriority(a) - getPriority(b) || a.localeCompare(b);
    });

    let weekdayTotalRows = 0;
    const categoryLayouts = {};

    categories.forEach(cat => {
      const catCourses = categoriesMap[cat];
      const subRows = [];

      catCourses.forEach(course => {
        const coursePeriods = [];
        periods.forEach(p => {
          if (p.toUpperCase() === 'LB') return;
          const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
          if (assigned.length > 0) coursePeriods.push(p);
        });

        if (coursePeriods.length === 0) return;

        let placed = false;
        for (let r = 0; r < subRows.length; r++) {
          const hasClash = coursePeriods.some(p => !!subRows[r][p]);
          if (!hasClash) {
            coursePeriods.forEach(p => {
              const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][p]) === 'P';
              const printClass = course.courseType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
              const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
              const tooltip = assigned.map(code => {
                const facObj = state.faculty.find(f => f.code === code);
                return facObj ? facObj.name : code;
              }).join(' / ');
              
              subRows[r][p] = {
                html: formatAllocationCell(course, day, p, allocations, displayMode),
                classes: printClass,
                tooltip: tooltip
              };
            });
            placed = true;
            break;
          }
        }

        if (!placed) {
          const newRow = {};
          coursePeriods.forEach(p => {
            const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][p]) === 'P';
            const printClass = course.courseType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
            const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
            const tooltip = assigned.map(code => {
              const facObj = state.faculty.find(f => f.code === code);
              return facObj ? facObj.name : code;
            }).join(' / ');

            newRow[p] = {
              html: formatAllocationCell(course, day, p, allocations, displayMode),
              classes: printClass,
              tooltip: tooltip
            };
          });
          subRows.push(newRow);
        }
      });

      if (subRows.length === 0) subRows.push({});
      categoryLayouts[cat] = subRows;
      weekdayTotalRows += subRows.length;
    });

    categories.forEach((cat, catIdx) => {
      const subRows = categoryLayouts[cat];
      subRows.forEach((srow, sidx) => {
        const tr = document.createElement('tr');
        
        if (catIdx === 0 && sidx === 0) {
          const tdDay = document.createElement('td');
          tdDay.rowSpan = weekdayTotalRows;
          tdDay.className = 'day-cell';
          tdDay.textContent = weekdayShort[day];
          tr.appendChild(tdDay);
        }

        if (sidx === 0) {
          const tdClass = document.createElement('td');
          tdClass.rowSpan = subRows.length;
          tdClass.className = 'class-cell';
          tdClass.textContent = cat;
          tr.appendChild(tdClass);
        }

        periods.forEach(p => {
          const td = document.createElement('td');
          if (p.toUpperCase() === 'LB') {
            td.className = 'break-cell';
            td.textContent = 'LB';
          } else {
            const cellData = srow[p];
            if (cellData) {
              td.innerHTML = cellData.html || '';
              if (cellData.classes) {
                cellData.classes.split(' ').filter(Boolean).forEach(cls => td.classList.add(cls));
              }
              if (cellData.tooltip) {
                td.setAttribute('title', cellData.tooltip);
              }
            } else {
              td.innerHTML = '';
            }
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    });
  });
}

function formatAllocationCell(course, day, period, allocations, mode) {
  const assignedCodes = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][period]) || [];
  if (assignedCodes.length === 0) return '';

  const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
  const groupSuffix = course.group > 0 ? ` (G${course.group})` : '';
  const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][period]) === 'P';

  let suffix = '';
  if (mode === 'full') {
    if (course.courseType === 'M') {
      suffix = ' (M)';
    } else {
      suffix = isPractical ? ' (PR)' : ' (TH)';
    }
  }

  if (mode === 'short') {
    return `${assignedCodes.join('/')} ${alias}${groupSuffix}${suffix}`;
  } else if (mode === 'medium') {
    return `${assignedCodes.join('/')} - ${alias}${groupSuffix}${suffix}`;
  } else {
    const facNames = assignedCodes.map(code => {
      const facObj = state.faculty.find(f => f.code === code);
      return facObj ? facObj.name : code;
    }).join(' / ');
    const cleanName = course.name.replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, '');
    return `<div class="bold">${facNames}</div><div class="text-sm">${cleanName}${groupSuffix}${suffix}</div>`;
  }
}


function exportPrintTimetableToCSV() {
  const table = document.getElementById('print-grid-table');
  let csv = [];
  const ths = table.querySelectorAll('thead th');
  csv.push(Array.from(ths).map(th => `"${th.textContent}"`).join(','));
  
  const trs = table.querySelectorAll('tbody tr');
  let currentDay = '';
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    let tdValues = Array.from(tds).map(td => td.textContent.replace(/[\n\r]+/g, ' ').trim());
    if (tds[0] && tds[0].className === 'day-cell') {
      currentDay = tdValues[0];
    } else {
      tdValues.unshift(currentDay);
    }
    csv.push(tdValues.map(v => `"${v}"`).join(','));
  });
  
  const csvContent = "data:text/csv;charset=utf-8," + csv.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${activePrintDept}_Timetable_Grid_${state.config.academicYear}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function renderBatchDeptMappings() {
  const tbody = document.querySelector('#table-batch-dept-mappings tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const mappings = state.batchDeptMappings || [];
  if (mappings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No mappings defined yet. Upload an Excel sheet or add one manually.</td></tr>';
    return;
  }

  mappings.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.code}</strong></td>
      <td>${m.deptName}</td>
      <td>
        <button class="btn btn-outline btn-sm btn-edit-mapping" style="padding:2px 8px;"><i class="fa-solid fa-edit"></i> Edit</button>
        <button class="btn btn-danger btn-sm btn-delete-mapping" style="padding:2px 8px;background-color:var(--danger);color:white;"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    `;
    tr.querySelector('.btn-edit-mapping').addEventListener('click', () => {
      document.getElementById('batch-dept-modal-title').textContent = 'Edit Mapping';
      const codeInput = document.getElementById('batch-dept-code-input');
      codeInput.value = m.code;
      codeInput.disabled = true;
      document.getElementById('batch-dept-name-input').value = m.deptName;
      document.getElementById('modal-batch-dept').classList.remove('hidden');
    });
    tr.querySelector('.btn-delete-mapping').addEventListener('click', async () => {
      showModalConfirm('Delete Mapping', `Delete mapping for code ${m.code}?`, async () => {
        try {
          const res = await fetch(`${API_BASE}/admin/batch-dept-mappings/${encodeURIComponent(m.code)}`, { method: 'DELETE' });
          const result = await res.json();
          if (res.ok) {
            showModalAlert('Success', 'Mapping deleted.', 'success');
            await fetchGlobalData();
            renderBatchDeptMappings();
            renderBatchPreview();
          } else {
            showModalAlert('Error', result.message || 'Failed.', 'danger');
          }
        } catch (e) { showModalAlert('Error', 'Connection error.', 'danger'); }
      });
    });
    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------
// Batch Config Editors
// -------------------------------------------------------
function makeKvRow(editorId, key, value, onDelete) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:5px;align-items:center;';
  row.dataset.key = key;
  row.innerHTML = `
    <input class="form-control kv-key" value="${key}" placeholder="Code" style="width:64px;padding:4px 6px;font-size:13px;">
    <span style="color:var(--text-muted);flex-shrink:0;">→</span>
    <input class="form-control kv-val" value="${value}" placeholder="Label" style="flex:1;padding:4px 6px;font-size:13px;">
    <button class="btn btn-sm" style="padding:2px 7px;background:var(--danger);color:white;border:none;border-radius:4px;flex-shrink:0;" title="Remove">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

function renderBatchConfig() {
  const cfg = state.batchConfig || {};
  const progTypes  = cfg.programTypes || {};
  const fundTypes  = cfg.fundingTypes  || {};
  const yearSemMap = cfg.yearSemMap    || {};

  function populateEditor(editorId, obj) {
    const el = document.getElementById(editorId);
    if (!el) return;
    el.innerHTML = '';
    Object.entries(obj).forEach(([k, v]) => {
      el.appendChild(makeKvRow(editorId, k, v));
    });
  }

  populateEditor('prog-type-editor', progTypes);
  populateEditor('fund-type-editor', fundTypes);

  // Year-sem map: values are arrays, display as comma-separated
  const yearEl = document.getElementById('year-sem-editor');
  if (yearEl) {
    yearEl.innerHTML = '';
    Object.entries(yearSemMap).forEach(([yr, sems]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:5px;align-items:center;';
      row.innerHTML = `
        <input class="form-control kv-key" value="${yr}" placeholder="Year" style="width:64px;padding:4px 6px;font-size:13px;">
        <span style="color:var(--text-muted);flex-shrink:0;">→ Sem</span>
        <input class="form-control kv-val" value="${Array.isArray(sems) ? sems.join(',') : sems}" placeholder="e.g. 5,6" style="flex:1;padding:4px 6px;font-size:13px;">
        <button class="btn btn-sm" style="padding:2px 7px;background:var(--danger);color:white;border:none;border-radius:4px;flex-shrink:0;" title="Remove">
          <i class="fa-solid fa-xmark"></i>
        </button>
      `;
      row.querySelector('button').addEventListener('click', () => row.remove());
      yearEl.appendChild(row);
    });
  }

  // Wire up Add-row buttons (re-bind to avoid duplicate listeners)
  const btnProg = document.getElementById('btn-add-prog-type');
  const btnFund = document.getElementById('btn-add-fund-type');
  const btnYear = document.getElementById('btn-add-year-sem');
  if (btnProg) { btnProg.onclick = () => document.getElementById('prog-type-editor').appendChild(makeKvRow('prog-type-editor', '', '')); }
  if (btnFund) { btnFund.onclick = () => document.getElementById('fund-type-editor').appendChild(makeKvRow('fund-type-editor', '', '')); }
  if (btnYear) {
    btnYear.onclick = () => {
      const yrEl = document.getElementById('year-sem-editor');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:5px;align-items:center;';
      row.innerHTML = `
        <input class="form-control kv-key" value="" placeholder="Year" style="width:64px;padding:4px 6px;font-size:13px;">
        <span style="color:var(--text-muted);flex-shrink:0;">→ Sem</span>
        <input class="form-control kv-val" value="" placeholder="e.g. 5,6" style="flex:1;padding:4px 6px;font-size:13px;">
        <button class="btn btn-sm" style="padding:2px 7px;background:var(--danger);color:white;border:none;border-radius:4px;flex-shrink:0;">
          <i class="fa-solid fa-xmark"></i>
        </button>
      `;
      row.querySelector('button').addEventListener('click', () => row.remove());
      yrEl.appendChild(row);
    };
  }
}

function readBatchConfigFromEditors() {
  function readKvEditor(editorId) {
    const obj = {};
    document.querySelectorAll(`#${editorId} .kv-key`).forEach(kEl => {
      const vEl = kEl.parentElement.querySelector('.kv-val');
      const k = kEl.value.trim();
      const v = vEl ? vEl.value.trim() : '';
      if (k) obj[k] = v;
    });
    return obj;
  }
  // Year-sem: values parsed as array of ints
  const yearSemMap = {};
  document.querySelectorAll('#year-sem-editor .kv-key').forEach(kEl => {
    const vEl = kEl.parentElement.querySelector('.kv-val');
    const yr = kEl.value.trim();
    const semStr = vEl ? vEl.value.trim() : '';
    if (yr) {
      yearSemMap[yr] = semStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    }
  });
  return {
    programTypes: readKvEditor('prog-type-editor'),
    fundingTypes:  readKvEditor('fund-type-editor'),
    yearSemMap
  };
}

function renderBatchPreview() {
  const chips = document.getElementById('batch-preview-chips');
  const count = document.getElementById('batch-preview-count');
  if (!chips) return;

  const batches = state.allBatches || [];
  if (batches.length === 0) {
    chips.innerHTML = '<span class="text-muted text-sm">No batches generated yet. Add dept codes and configure the batch settings above.</span>';
    if (count) count.textContent = '0 batches';
    return;
  }

  if (count) count.textContent = `${batches.length} batches`;
  chips.innerHTML = '';
  batches.forEach(b => {
    const chip = document.createElement('span');
    chip.title = b.batchLabel || b.batchId;
    chip.style.cssText = 'display:inline-block;background:var(--surface-2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600;cursor:default;';
    chip.textContent = b.batchId;
    chips.appendChild(chip);
  });
}

function renderGroupMappings() {
  const tbody = document.querySelector('#table-group-mappings tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const groupCourses = state.courses.filter(c => c.group && c.group > 0);
  if (groupCourses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No group courses found. Import a course Excel with group column values greater than 0.</td></tr>';
    return;
  }

  const uniqGroupCourses = [];
  groupCourses.forEach(c => {
    if (!uniqGroupCourses.some(uc => uc.code === c.code)) uniqGroupCourses.push(c);
  });

  uniqGroupCourses.forEach(c => {
    const tr = document.createElement('tr');
    const mapped = c.mappedBatches || [];
    const baseCode = c.code.replace(/_G\d+$/, '');

    tr.innerHTML = `
      <td><strong>${baseCode}</strong></td>
      <td>${c.name}</td>
      <td><span class="badge" style="background:var(--accent);color:var(--accent-dark);font-weight:bold;border:1.5px solid var(--accent-dark);">G${c.group}</span></td>
      <td>${mapped.length > 0
        ? mapped.map(b => `<span class="badge badge-info" style="margin:2px;">${b}</span>`).join('')
        : '<span class="text-muted text-sm">No batches mapped</span>'}</td>
      <td>
        <button class="btn btn-primary btn-sm btn-map-batches" style="padding:2px 8px;">
          <i class="fa-solid fa-link"></i> Map Batches
        </button>
      </td>
    `;

    tr.querySelector('.btn-map-batches').addEventListener('click', () => {
      openGroupMappingModal(c, mapped);
    });

    tbody.appendChild(tr);
  });
}

function openGroupMappingModal(course, initialMapped) {
  // Work on a mutable copy; sync to modal dataset so save button can read it
  const currentMapped = [...initialMapped];
  const modal = document.getElementById('modal-group-mapping');
  const syncDataset = () => { modal.dataset.currentMapped = JSON.stringify(currentMapped); };
  syncDataset();

  const baseCode = course.code.replace(/_G\d+$/, '');
  document.getElementById('mapping-course-code').value = course.code;
  document.getElementById('mapping-course-title').textContent = `${baseCode}  (Group ${course.group}) — ${course.name}`;

  const cfg = state.batchConfig || {};
  const progTypes = cfg.programTypes || {};
  const fundTypes  = cfg.fundingTypes  || {};

  // Populate filter dropdowns
  const selProg = document.getElementById('batch-filter-prog');
  const selFund = document.getElementById('batch-filter-fund');
  const selYear = document.getElementById('batch-filter-year');
  const selDept = document.getElementById('batch-filter-dept');
  const searchInput = document.getElementById('batch-search-input');

  // Reset
  selProg.innerHTML = '<option value="">All Programs</option>';
  selFund.innerHTML = '<option value="">All Funding</option>';
  selYear.innerHTML = '<option value="">All Years</option>';
  selDept.innerHTML = '<option value="">All Depts</option>';
  if (searchInput) searchInput.value = '';

  Object.entries(progTypes).forEach(([code, label]) => {
    selProg.innerHTML += `<option value="${code}">${label} (${code})</option>`;
  });
  Object.entries(fundTypes).forEach(([code, label]) => {
    selFund.innerHTML += `<option value="${code}">${label} (${code})</option>`;
  });
  
  const years = [...new Set((state.allBatches || []).map(b => b.year))].sort();
  years.forEach(yr => {
    selYear.innerHTML += `<option value="${yr}">${yr}</option>`;
  });

  const deptCodes = [...new Set((state.allBatches || []).map(b => b.deptCode))].sort();
  deptCodes.forEach(dc => {
    selDept.innerHTML += `<option value="${dc}">${dc}</option>`;
  });

  // Calculate default year mapping from semester
  let courseYear = '';
  const semNum = parseInt(course.semester);
  if (!isNaN(semNum) && cfg.yearSemMap) {
    Object.entries(cfg.yearSemMap).forEach(([yr, sems]) => {
      if (Array.isArray(sems) && sems.some(s => parseInt(s) === semNum)) {
        courseYear = yr;
      }
    });
  }

  // Pre-fill smart defaults
  let defaultProg = '';
  if (course.programType) {
    const pt = course.programType.toUpperCase();
    const foundKey = Object.keys(progTypes).find(k => k.toUpperCase() === pt || progTypes[k].toUpperCase() === pt);
    if (foundKey) {
      defaultProg = foundKey;
    } else {
      if (pt === 'UG') defaultProg = 'U';
      else if (pt === 'PG') defaultProg = 'P';
    }
  }
  selProg.value = defaultProg;
  selFund.value = '1'; // Default to Aided
  selYear.value = courseYear || '';
  selDept.value = '';

  function renderBatchCheckboxes() {
    const container = document.getElementById('group-mapping-checkboxes');
    const noResults = document.getElementById('batch-no-results');
    container.innerHTML = '';

    const search = (searchInput ? searchInput.value.trim().toLowerCase() : '');
    const filterProg = selProg.value;
    const filterFund = selFund.value;
    const filterYear = selYear.value;
    const filterDept = selDept.value;

    const batches = state.allBatches || [];
    if (batches.length === 0) {
      container.innerHTML = '<p class="text-muted text-center py-3 text-sm">No batches generated. Configure Batch Config first.</p>';
      return;
    }

    const filtered = batches.filter(b => {
      if (search) {
        const idMatch = b.batchId.toLowerCase().includes(search);
        const deptCodeMatch = b.deptCode && b.deptCode.toLowerCase().includes(search);
        const deptNameMatch = b.deptName && b.deptName.toLowerCase().includes(search);
        if (!idMatch && !deptCodeMatch && !deptNameMatch) return false;
      }
      if (filterProg && b.prog !== filterProg) return false;
      if (filterFund && b.fund !== filterFund) return false;
      if (filterYear && String(b.year) !== filterYear) return false;
      if (filterDept && b.deptCode !== filterDept) return false;
      return true;
    });

    if (noResults) noResults.classList.toggle('hidden', filtered.length > 0);

    filtered.forEach(batch => {
      const isChecked = currentMapped.includes(batch.batchId);
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
      div.innerHTML = `
        <input type="checkbox" id="cb-batch-${batch.batchId}" value="${batch.batchId}" ${isChecked ? 'checked' : ''}>
        <label for="cb-batch-${batch.batchId}" style="cursor:pointer;font-size:13px;">
          <strong>${batch.batchId}</strong>
          <span class="text-muted" style="font-size:11px;"> — ${batch.batchLabel || ''}</span>
        </label>
      `;
      // Update currentMapped on check/uncheck so chips stay in sync
      div.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) {
          if (!currentMapped.includes(batch.batchId)) currentMapped.push(batch.batchId);
        } else {
          const idx = currentMapped.indexOf(batch.batchId);
          if (idx > -1) currentMapped.splice(idx, 1);
        }
        syncDataset();
        updateSelectedChips();
      });
      container.appendChild(div);
    });
  }

  function updateSelectedChips() {
    const chipsEl = document.getElementById('group-mapping-selected-chips');
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    currentMapped.forEach(bId => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--primary-muted);color:var(--primary);border-radius:20px;padding:2px 8px;font-size:12px;font-weight:600;';
      chip.innerHTML = `${bId} <i class="fa-solid fa-xmark" style="cursor:pointer;font-size:10px;" data-id="${bId}"></i>`;
      chip.querySelector('i').addEventListener('click', () => {
        const idx = currentMapped.indexOf(bId);
        if (idx > -1) currentMapped.splice(idx, 1);
        const cb = document.getElementById(`cb-batch-${bId}`);
        if (cb) cb.checked = false;
        syncDataset();
        updateSelectedChips();
      });
      chipsEl.appendChild(chip);
    });
  }

  // Bind filter events
  if (searchInput) searchInput.oninput = renderBatchCheckboxes;
  selProg.onchange = renderBatchCheckboxes;
  selFund.onchange = renderBatchCheckboxes;
  selYear.onchange = renderBatchCheckboxes;
  selDept.onchange = renderBatchCheckboxes;

  renderBatchCheckboxes();
  updateSelectedChips();

  document.getElementById('modal-group-mapping').classList.remove('hidden');
}
