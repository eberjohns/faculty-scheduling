// ==========================================================================
// Central Admin Portal Client Script
// ==========================================================================

const API_BASE = '/api';

// Global Fetch Interceptor to attach adminToken automatically
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  const urlStr = typeof url === 'string' ? url : (url.url || '');
  const isProtectedApi = urlStr.includes('/api') && !urlStr.includes('/auth/login');
  if (isProtectedApi) {
    if (!options.headers) {
      options.headers = {};
    }
    const token = sessionStorage.getItem('adminToken') || 'admin-token';
    if (token) {
      if (options.headers instanceof Headers) {
        options.headers.set('Authorization', token);
      } else {
        options.headers['Authorization'] = token;
      }
    }
  }
  return originalFetch(url, options);
};

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

  // Major Mapping Export
  const btnExportMajorMappings = document.getElementById('btn-export-major-mappings');
  if (btnExportMajorMappings) {
    btnExportMajorMappings.addEventListener('click', () => {
      const adminToken = sessionStorage.getItem('adminToken') || 'admin-token';
      window.location.href = `${API_BASE}/admin/export/major-mappings?token=${encodeURIComponent(adminToken)}`;
    });
  }

  // Major Mapping Import file triggers
  const btnTriggerImportMajorMappings = document.getElementById('btn-trigger-import-major-mappings');
  const fileInputMajorMappings = document.getElementById('import-major-mappings-file');

  if (btnTriggerImportMajorMappings && fileInputMajorMappings) {
    btnTriggerImportMajorMappings.addEventListener('click', () => {
      fileInputMajorMappings.click();
    });

    fileInputMajorMappings.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch(`${API_BASE}/import/major-mappings`, {
          method: 'POST',
          body: formData
        });
        const result = await res.json();
        fileInputMajorMappings.value = '';

        if (res.ok) {
          showModalAlert('Success', result.message || 'Major mappings imported successfully.', 'success');
          await fetchGlobalData();
          renderMajorAllocations();
          renderBatchAllocationStatus();
        } else {
          showModalAlert('Error', result.error || 'Failed to import mappings.', 'danger');
        }
      } catch (err) {
        fileInputMajorMappings.value = '';
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
  bindGlobalLocksEvents();
  await loadGlobalLocks();
  // Handle Batch Allocation sub-tabs switching
  document.querySelectorAll('#tab-admin-group-mappings .tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-admin-group-mappings .tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetSubtab = btn.getAttribute('data-subtab');
      document.querySelectorAll('#tab-admin-group-mappings .subtab-pane').forEach(p => {
        if (p.id === targetSubtab) {
          p.classList.remove('hidden');
        } else {
          p.classList.add('hidden');
        }
      });
      // Refresh subtab content
      if (targetSubtab === 'subtab-alloc-electives') {
        renderGroupMappings();
      } else if (targetSubtab === 'subtab-alloc-majors') {
        renderMajorAllocations();
      } else if (targetSubtab === 'subtab-alloc-status') {
        renderBatchAllocationStatus();
      }
    });
  });

  // Bind period times save button
  const btnSavePeriodTimes = document.getElementById('btn-save-period-times');
  if (btnSavePeriodTimes) {
    btnSavePeriodTimes.addEventListener('click', async () => {
      const times = {
        "1": document.getElementById('pt-1').value.trim(),
        "2": document.getElementById('pt-2').value.trim(),
        "3": document.getElementById('pt-3').value.trim(),
        "4": document.getElementById('pt-4').value.trim(),
        "5": document.getElementById('pt-5').value.trim(),
        "6": document.getElementById('pt-6').value.trim(),
        "7": document.getElementById('pt-7').value.trim()
      };
      try {
        const res = await fetch(`${API_BASE}/admin/period-times`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(times)
        });
        if (res.ok) {
          showModalAlert('Success', 'Period time configuration saved successfully.', 'success');
        } else {
          showModalAlert('Error', 'Failed to save period times.', 'danger');
        }
      } catch (err) {
        showModalAlert('Error', 'Connection error.', 'danger');
      }
    });
  }

  // Bind Export Strict Timetable button
  const btnExportStrictExcel = document.getElementById('btn-export-strict-excel');
  if (btnExportStrictExcel) {
    btnExportStrictExcel.addEventListener('click', () => {
      const adminToken = sessionStorage.getItem('adminToken') || 'admin-token';
      window.location.href = `${API_BASE}/admin/export/strict-timetable?token=${encodeURIComponent(adminToken)}`;
    });
  }

  // Bind change admin password form
  const formChangeAdminPwd = document.getElementById('form-change-admin-pwd');
  if (formChangeAdminPwd) {
    formChangeAdminPwd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('admin-current-pwd').value;
      const newPassword = document.getElementById('admin-new-pwd').value;
      const confirmInput = document.getElementById('admin-confirm-pwd');
      const confirmPassword = confirmInput ? confirmInput.value : newPassword;

      if (newPassword !== confirmPassword) {
        showModalAlert('Validation Error', 'New passwords do not match. Please re-type your new password.', 'warning');
        return;
      }

      if (newPassword.length < 4) {
        showModalAlert('Validation Error', 'New password must be at least 4 characters long.', 'warning');
        return;
      }
      
      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        const res = await fetch(`${API_BASE}/admin/change-password`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': token
          },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const result = await res.json();
        if (res.ok) {
          showModalAlert('Success', 'Administrator password updated successfully!', 'success');
          formChangeAdminPwd.reset();
        } else {
          showModalAlert('Error', result.message || 'Failed to update password.', 'danger');
        }
      } catch (err) {
        showModalAlert('Error', 'Connection error.', 'danger');
      }
    });
  }

  const selectPreview = document.getElementById('export-preview-batch-select');
  if (selectPreview) {
    selectPreview.addEventListener('change', (e) => {
      renderBatchTimetablePreview(e.target.value);
    });
  }
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
    const [configRes, deptsRes, coursesRes, facultyRes, batchDeptsRes, batchCfgRes, groupRes, allBatchesRes, allocationsRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/admin/departments`, { headers: { 'Authorization': token } }),
      fetch(`${API_BASE}/courses`),
      fetch(`${API_BASE}/faculty`),
      fetch(`${API_BASE}/admin/batch-dept-mappings`),
      fetch(`${API_BASE}/admin/batch-config`),
      fetch(`${API_BASE}/admin/group-mappings`),
      fetch(`${API_BASE}/batches`),
      fetch(`${API_BASE}/allocations`)
    ]);

    state.config          = await configRes.json();
    state.departments     = await deptsRes.json();
    state.courses         = await coursesRes.json();
    state.faculty         = await facultyRes.json();
    state.batchDeptMappings = await batchDeptsRes.json();
    state.batchConfig     = await batchCfgRes.json();
    state.groupMappings   = await groupRes.json();
    state.allBatches      = await allBatchesRes.json();
    state.allocations     = await allocationsRes.json();

    if (state.config && Array.isArray(state.config.globalLockedPeriods)) {
      localGlobalLocks = JSON.parse(JSON.stringify(state.config.globalLockedPeriods));
      if (state.currentTab === 'tab-admin-global-locks') {
        renderGlobalLocksGrid();
      }
    }

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

async function showTab(tabId) {
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
    // Admin password form tab - no dynamic table needed
  } else if (tabId === 'tab-admin-data') {
    renderInspectRecords();
  } else if (tabId === 'tab-admin-batch-dept') {
    renderBatchDeptMappings();
    renderBatchConfig();
    renderBatchPreview();
  } else if (tabId === 'tab-admin-group-mappings') {
    renderGroupMappings();
    renderMajorAllocations();
    renderBatchAllocationStatus();
  } else if (tabId === 'tab-admin-global-locks') {
    await loadGlobalLocks();
    renderGlobalLocksGrid();
  } else if (tabId === 'tab-admin-export') {
    loadPeriodTimes();
    populateExportPreviewDropdown();
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

  // Backup & Restore Database click handlers
  const btnBackupDb = document.getElementById('btn-backup-db');
  if (btnBackupDb) {
    btnBackupDb.addEventListener('click', () => {
      const token = sessionStorage.getItem('adminToken');
      if (!token) return;
      window.location.href = `${API_BASE}/admin/backup?token=${encodeURIComponent(token)}`;
    });
  }

  const btnTriggerRestoreDb = document.getElementById('btn-trigger-restore-db');
  const restoreDbFile = document.getElementById('restore-db-file');

  if (btnTriggerRestoreDb && restoreDbFile) {
    btnTriggerRestoreDb.addEventListener('click', () => {
      restoreDbFile.click();
    });

    restoreDbFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const confirmed = window.confirm("Are you sure you want to restore the database from backup? This will overwrite the current database.");
      if (!confirmed) {
        restoreDbFile.value = '';
        return;
      }

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch(`${API_BASE}/admin/restore`, {
          method: 'POST',
          body: formData
        });

        const data = await res.json();
        restoreDbFile.value = '';

        if (res.ok && data.success) {
          showModalAlert('Database Restored', 'The database has been successfully restored.', 'success');
          await fetchGlobalData();
          showTab('tab-admin-dashboard');
        } else {
          showModalAlert('Error', 'Failed to restore database: ' + (data.message || 'Unknown error'), 'danger');
        }
      } catch (err) {
        console.error(err);
        restoreDbFile.value = '';
        showModalAlert('Error', 'An error occurred during database restoration.', 'danger');
      }
    });
  }
}

// Passwords Editor
function renderPasswordTable() {
  const tbody = document.querySelector('#table-dept-passwords tbody');
  if (!tbody) return;
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
        <button class="btn btn-outline btn-sm btn-danger btn-delete-course" style="padding: 2px 8px; margin-left: 4px;"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    `;
    tr.querySelector('.btn-edit-course').addEventListener('click', () => {
      document.getElementById('edit-course-code').value = c.code;
      document.getElementById('edit-course-name').value = c.name;
      document.getElementById('edit-course-alias').value = c.alias || '';
      document.getElementById('modal-edit-course').classList.remove('hidden');
    });
    tr.querySelector('.btn-delete-course').addEventListener('click', () => {
      showModalConfirm(
        'Delete Course?',
        `Are you sure you want to delete course '${c.name}' (${c.code.replace(/_G\d+$/, '')})? This will also remove all its allocations and group mappings.`,
        async () => {
          try {
            const res = await fetch(`${API_BASE}/admin/courses/${encodeURIComponent(c.code)}`, {
              method: 'DELETE'
            });
            const result = await res.json();
            if (res.ok) {
              showModalAlert('Success', 'Course deleted successfully.', 'success');
              await fetchGlobalData();
              renderInspectRecords();
            } else {
              showModalAlert('Error', result.message || 'Failed to delete course.', 'danger');
            }
          } catch (e) {
            showModalAlert('Error', 'Connection error.', 'danger');
          }
        }
      );
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
      <td>
        <button class="btn btn-outline btn-sm btn-danger btn-delete-faculty" style="padding: 2px 8px;"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    `;
    tr.querySelector('.btn-delete-faculty').addEventListener('click', () => {
      showModalConfirm(
        'Delete Faculty Member?',
        `Are you sure you want to delete '${f.name}' (${f.staffId})? This will also remove this teacher from all allocated slots across all timetables.`,
        async () => {
          try {
            const res = await fetch(`${API_BASE}/admin/faculty/${encodeURIComponent(f.staffId)}`, {
              method: 'DELETE'
            });
            const result = await res.json();
            if (res.ok) {
              showModalAlert('Success', 'Faculty member deleted successfully.', 'success');
              await fetchGlobalData();
              renderInspectRecords();
            } else {
              showModalAlert('Error', result.message || 'Failed to delete faculty member.', 'danger');
            }
          } catch (e) {
            showModalAlert('Error', 'Connection error.', 'danger');
          }
        }
      );
    });
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

  const btnSwitch = document.getElementById('btn-switch-to-teacher-timetable');
  if (btnSwitch) {
    btnSwitch.addEventListener('click', () => {
      document.getElementById('modal-print-preview').classList.add('hidden');
      openAdminTeacherTimetableModal(activePrintDept, 'ALL');
    });
  }
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

function formatCategory(cat) {
  if (!cat) return "Major";
  const upper = cat.toUpperCase();
  if (["MDC", "SEC", "AEC", "VAC", "OEC", "VBC"].includes(upper)) {
    return upper;
  }
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

function getTimetableRowCategory(course) {
  const semLabel = state.config.semesterLabels[course.semester] || `${course.semester} Sem`;
  const catStr = formatCategory(course.category);
  
  if (semLabel.toUpperCase().includes('BSC') || semLabel.toUpperCase().includes('MSC')) {
    return `${semLabel} ${catStr}`;
  }
  
  const isPg = course.code.toUpperCase().includes('MSC') || 
               course.pathway.toUpperCase().includes('MSC') || 
               course.pathway.toUpperCase().includes('POST GRADUATE') ||
               course.programType === 'PG';
  const progLabel = isPg ? 'MSC' : 'BSC';
  return `${semLabel} ${progLabel} ${catStr}`;
}

function renderPrintGridRows(courses, allocations, periods, displayMode, tbody) {
  tbody.innerHTML = '';
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const weekdayShort = { "MONDAY": "MON", "TUESDAY": "TUES", "WEDNESDAY": "WED", "THURSDAY": "THUR", "FRIDAY": "FRI" };

  // Expand courses that have classes > 1 into virtual course objects!
  const expandedCourses = [];
  courses.forEach(c => {
    if (c.classes && c.classes > 1) {
      for (let cl = 1; cl <= c.classes; cl++) {
        const base = c.code.replace(/-(T|P)$/, '');
        const suffix = c.code.match(/-(T|P)$/) ? c.code.match(/-(T|P)$/)[0] : '';
        expandedCourses.push({
          ...c,
          code: `${base}_C${cl}${suffix}`,
          classNum: cl
        });
      }
    } else {
      expandedCourses.push(c);
    }
  });

  weekdays.forEach(day => {
    const categoriesMap = {};
    expandedCourses.forEach(c => {
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

  const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const groupSuffix = course.group > 0 ? ` (G${course.group})` : (course.classNum ? ` (Class ${course.classNum})` : '');
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

// -------------------------------------------------------------
// Admin Teacher-wise Timetable Engine & PDF Export
// -------------------------------------------------------------
let adminActiveTeacherDept = '';

function bindAdminTeacherTimetableEvents() {
  const btnClose = document.getElementById('btn-close-teacher-modal');
  if (btnClose) {
    btnClose.onclick = () => {
      const modal = document.getElementById('modal-teacher-timetable');
      if (modal) modal.classList.add('hidden');
    };
  }

  const selectFac = document.getElementById('select-teacher-timetable-faculty');
  const selectMode = document.getElementById('select-teacher-timetable-mode');
  const printArea = document.getElementById('teacher-print-area');

  if (selectFac && printArea) {
    selectFac.onchange = async () => {
      const mode = selectMode ? selectMode.value : 'medium';
      await renderAdminTeacherTimetables(printArea, adminActiveTeacherDept, selectFac.value, mode);
    };
  }

  if (selectMode && printArea) {
    selectMode.onchange = async () => {
      const facCode = selectFac ? selectFac.value : 'ALL';
      await renderAdminTeacherTimetables(printArea, adminActiveTeacherDept, facCode, selectMode.value);
    };
  }

  const btnPrint = document.getElementById('btn-trigger-teacher-print');
  if (btnPrint) {
    btnPrint.onclick = () => {
      window.print();
    };
  }

  const btnExportCsv = document.getElementById('btn-export-teacher-csv');
  if (btnExportCsv) {
    btnExportCsv.onclick = async () => {
      const facCode = selectFac ? selectFac.value : 'ALL';
      await exportAdminTeacherTimetableToCSV(adminActiveTeacherDept, facCode);
    };
  }
}

async function fetchDeptAllocations(deptName) {
  try {
    const res = await fetch(`${API_BASE}/allocations?department=${encodeURIComponent(deptName)}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.error(err);
  }
  return {};
}

async function renderAdminTeacherTimetables(containerElement, deptName, targetFacultyCode = 'ALL', displayMode = 'medium') {
  if (!containerElement) return;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

  const deptAlloc = await fetchDeptAllocations(deptName);

  const schedules = {};
  deptFaculty.forEach(fac => {
    schedules[fac.code] = {
      info: fac,
      totalHours: 0,
      theoryHours: 0,
      practicalHours: 0,
      slots: {}
    };
    weekdays.forEach(d => {
      schedules[fac.code].slots[d] = {};
    });
  });

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    const baseCode = cCode.replace(/-(T|P)$/, '').replace(/_C\d+-(T|P)$/, '').replace(/_C\d+$/, '').replace(/_G\d+$/, '');
    const course = state.courses.find(c => c.code === cCode) || 
                   state.courses.find(c => c.code === baseCode) || 
                   { code: cCode, name: cCode, alias: cCode, semester: '-', category: '-', courseType: 'T' };

    const isPrac = (course.courseType === 'P' || cCode.endsWith('-P'));

    Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (Array.isArray(facList)) {
          facList.forEach(facCode => {
            if (schedules[facCode]) {
              if (!schedules[facCode].slots[dayUpper]) {
                schedules[facCode].slots[dayUpper] = {};
              }
              if (!schedules[facCode].slots[dayUpper][period]) {
                schedules[facCode].slots[dayUpper][period] = [];
              }
              schedules[facCode].slots[dayUpper][period].push({
                courseCode: cCode,
                courseName: course.name,
                courseAlias: course.alias || course.name,
                semester: course.semester,
                category: course.category,
                type: isPrac ? 'P' : 'T'
              });
              schedules[facCode].totalHours++;
              if (isPrac) schedules[facCode].practicalHours++;
              else schedules[facCode].theoryHours++;
            }
          });
        }
      });
    });
  });

  const facultyList = targetFacultyCode === 'ALL'
    ? Object.values(schedules)
    : [schedules[targetFacultyCode]].filter(Boolean);

  if (facultyList.length === 0) {
    containerElement.innerHTML = `
      <div class="text-center text-muted" style="padding: 40px 20px;">
        <i class="fa-solid fa-user-slash" style="font-size: 36px; margin-bottom: 12px; color: #cbd5e1;"></i>
        <p>No faculty members found for ${deptName}.</p>
      </div>
    `;
    return;
  }

  containerElement.innerHTML = facultyList.map(facSched => {
    const fac = facSched.info;
    let theadHtml = `
      <tr>
        <th class="teacher-day-th">Day</th>
        ${periods.map(p => `<th>${String(p).toUpperCase() === 'LB' ? 'Lunch Break' : `Period ${p}`}</th>`).join('')}
      </tr>
    `;

    let tbodyHtml = '';
    weekdays.forEach(day => {
      let cellsHtml = `<td class="teacher-day-cell"><strong>${day}</strong></td>`;
      periods.forEach(p => {
        const pUpper = String(p).toUpperCase();
        if (pUpper === 'LB') {
          cellsHtml += `<td class="teacher-slot-lb">LB</td>`;
          return;
        }

        const assignedList = facSched.slots[day] && facSched.slots[day][p];
        if (assignedList && assignedList.length > 0) {
          const itemHtmls = assignedList.map(item => {
            const isP = item.type === 'P';
            const typeLabel = isP ? 'PR' : 'TH';
            let dispText = item.courseAlias;
            if (displayMode === 'short') dispText = item.courseCode;
            else if (displayMode === 'full') dispText = `${item.courseName} (${item.courseCode})`;
            else dispText = `${item.courseAlias || item.courseCode}`;

            const semLabel = item.semester && item.semester !== '-' ? `Sem ${item.semester}` : '';

            return `
              <div class="teacher-slot-inner">
                <span class="teacher-slot-course" title="${item.courseName} (${item.courseCode})">${dispText}</span>
                <div style="display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 2px;">
                  ${semLabel ? `<span class="teacher-slot-sem-pill">${semLabel}</span>` : ''}
                  <span class="teacher-slot-type-badge">${typeLabel}</span>
                </div>
              </div>
            `;
          }).join('<div style="border-top: 1px dashed rgba(0,0,0,0.15); margin: 3px 0;"></div>');

          const primaryTypeClass = assignedList.some(x => x.type === 'P') ? 'teacher-slot-pr' : 'teacher-slot-th';
          cellsHtml += `<td class="${primaryTypeClass}">${itemHtmls}</td>`;
        } else {
          cellsHtml += `<td class="teacher-slot-free">—</td>`;
        }
      });

      tbodyHtml += `<tr>${cellsHtml}</tr>`;
    });

    return `
      <div class="teacher-sheet-page">
        <div class="print-header text-center" style="margin-bottom: 12px;">
          <h2 style="font-size: 16px; margin: 0; font-weight: 800; letter-spacing: 0.5px;">ST. THOMAS COLLEGE (AUTONOMOUS), THRISSUR</h2>
          <h3 style="font-size: 14px; margin: 2px 0; color: #475569;">DEPARTMENT OF ${deptName}</h3>
          <h4 style="font-size: 12px; margin: 0; color: #64748b; font-weight: 600;">TEACHER INDIVIDUAL TIMETABLE & WORKLOAD – <span class="uppercase">${state.config.semesterType || 'ODD'} SEMESTER</span> ${state.config.academicYear || ''}</h4>
        </div>

        <div class="teacher-meta-header">
          <div class="teacher-meta-left">
            <h3>
              <i class="fa-solid fa-user-tie text-primary"></i> ${fac.name} 
              <span class="teacher-code-pill">${fac.code}</span>
            </h3>
            <span class="text-muted text-sm">${fac.designation || 'Faculty Member'} | Department of ${deptName}</span>
          </div>
          <div class="teacher-meta-right">
            <span class="teacher-stat-badge teacher-stat-total" title="Total teaching periods per week">
              <i class="fa-solid fa-clock"></i> Total: <strong>${facSched.totalHours} hrs/week</strong>
            </span>
            <span class="teacher-stat-badge teacher-stat-th" title="Theory hours per week">
              <i class="fa-solid fa-book-open"></i> Theory: <strong>${facSched.theoryHours} hrs</strong>
            </span>
            <span class="teacher-stat-badge teacher-stat-pr" title="Practical lab hours per week">
              <i class="fa-solid fa-flask"></i> Practical: <strong>${facSched.practicalHours} hrs</strong>
            </span>
          </div>
        </div>

        <table class="teacher-grid-table">
          <thead>${theadHtml}</thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
      </div>
    `;
  }).join('');
}

async function exportAdminTeacherTimetableToCSV(deptName, targetFacultyCode = 'ALL') {
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const deptAlloc = await fetchDeptAllocations(deptName);

  const schedules = {};
  deptFaculty.forEach(fac => {
    schedules[fac.code] = {
      info: fac,
      totalHours: 0,
      theoryHours: 0,
      practicalHours: 0,
      slots: {}
    };
    weekdays.forEach(d => {
      schedules[fac.code].slots[d] = {};
    });
  });

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    const baseCode = cCode.replace(/-(T|P)$/, '').replace(/_C\d+-(T|P)$/, '').replace(/_C\d+$/, '').replace(/_G\d+$/, '');
    const course = state.courses.find(c => c.code === cCode) || 
                   state.courses.find(c => c.code === baseCode) || 
                   { code: cCode, name: cCode, alias: cCode, semester: '-', category: '-', courseType: 'T' };
    const isPrac = (course.courseType === 'P' || cCode.endsWith('-P'));

    Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (Array.isArray(facList)) {
          facList.forEach(facCode => {
            if (schedules[facCode]) {
              if (!schedules[facCode].slots[dayUpper]) schedules[facCode].slots[dayUpper] = {};
              if (!schedules[facCode].slots[dayUpper][period]) schedules[facCode].slots[dayUpper][period] = [];
              schedules[facCode].slots[dayUpper][period].push({
                courseCode: cCode,
                courseAlias: course.alias || course.name,
                semester: course.semester,
                type: isPrac ? 'P' : 'T'
              });
              schedules[facCode].totalHours++;
              if (isPrac) schedules[facCode].practicalHours++;
              else schedules[facCode].theoryHours++;
            }
          });
        }
      });
    });
  });

  const facultyList = targetFacultyCode === 'ALL'
    ? Object.values(schedules)
    : [schedules[targetFacultyCode]].filter(Boolean);

  let csvRows = [];
  csvRows.push([`ST. THOMAS COLLEGE (AUTONOMOUS) - DEPARTMENT OF ${deptName}`]);
  csvRows.push([`TEACHER TIMETABLE REPORT - ${state.config.semesterType || 'ODD'} SEMESTER ${state.config.academicYear || ''}`]);
  csvRows.push([]);

  facultyList.forEach(facSched => {
    const fac = facSched.info;
    csvRows.push([`Teacher:`, `"${fac.name}"`, `Code:`, `"${fac.code}"`, `Workload:`, `"${facSched.totalHours} hrs/week (${facSched.theoryHours} TH, ${facSched.practicalHours} PR)"`]);
    csvRows.push(['Day', ...periods.map(p => String(p).toUpperCase() === 'LB' ? 'LB' : `Period ${p}`)]);

    weekdays.forEach(day => {
      const row = [day];
      periods.forEach(p => {
        if (String(p).toUpperCase() === 'LB') {
          row.push('Lunch Break');
          return;
        }
        const assigned = facSched.slots[day] && facSched.slots[day][p];
        if (assigned && assigned.length > 0) {
          const text = assigned.map(a => `${a.courseAlias || a.courseCode} (Sem ${a.semester}, ${a.type})`).join(' / ');
          row.push(`"${text}"`);
        } else {
          row.push('Free');
        }
      });
      csvRows.push(row);
    });
    csvRows.push([]);
  });

  const csvString = csvRows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const filename = targetFacultyCode === 'ALL'
    ? `${deptName}_All_Teachers_Timetable_${state.config.academicYear || '2026'}.csv`
    : `${deptName}_Teacher_${targetFacultyCode}_Timetable_${state.config.academicYear || '2026'}.csv`;
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function openAdminTeacherTimetableModal(deptName, selectedFacultyCode = 'ALL') {
  adminActiveTeacherDept = deptName;
  bindAdminTeacherTimetableEvents();

  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const selectFac = document.getElementById('select-teacher-timetable-faculty');
  if (selectFac) {
    selectFac.innerHTML = `
      <option value="ALL">All Teachers (${deptFaculty.length} Faculty Members)</option>
      ${deptFaculty.map(f => `<option value="${f.code}">${f.name} (${f.code})</option>`).join('')}
    `;
    selectFac.value = selectedFacultyCode;
  }

  const modeSelect = document.getElementById('select-teacher-timetable-mode');
  const mode = modeSelect ? modeSelect.value : 'medium';

  const container = document.getElementById('teacher-print-area');
  await renderAdminTeacherTimetables(container, deptName, selectedFacultyCode, mode);

  const modal = document.getElementById('modal-teacher-timetable');
  if (modal) modal.classList.remove('hidden');
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
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600;cursor:default;';
    chip.innerHTML = `${b.batchId} <i class="fa-solid fa-xmark text-danger" style="cursor:pointer;font-size:10px;margin-left:2px;" title="Exclude Batch"></i>`;
    
    chip.querySelector('i').addEventListener('click', (e) => {
      e.stopPropagation();
      showModalConfirm(
        'Exclude Batch?',
        `Are you sure you want to delete/exclude batch '${b.batchId}'? This will remove it from all allocation selectors.`,
        async () => {
          try {
            const res = await fetch(`${API_BASE}/admin/batches/exclude`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ batchId: b.batchId })
            });
            if (res.ok) {
              const bRes = await fetch(`${API_BASE}/batches`);
              state.allBatches = await bRes.json();
              renderBatchPreview();
              renderBatchAllocationStatus();
              renderMajorAllocations();
            } else {
              showModalAlert('Error', 'Failed to exclude batch.', 'danger');
            }
          } catch (err) {
            showModalAlert('Error', 'Connection error.', 'danger');
          }
        }
      );
    });

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

function openGroupMappingModal(course, initialMapped, isSingleSelect = false) {
  // Work on a mutable copy; sync to modal dataset so save button can read it
  const currentMapped = [...initialMapped];
  const modal = document.getElementById('modal-group-mapping');
  modal.dataset.isSingleSelect = isSingleSelect ? 'true' : 'false';
  const syncDataset = () => { modal.dataset.currentMapped = JSON.stringify(currentMapped); };
  syncDataset();

  const baseCode = course.code.replace(/_G\d+$/, '');
  document.getElementById('mapping-course-code').value = course.code;
  
  if (isSingleSelect) {
    document.getElementById('mapping-course-title').textContent = `Assign Batch for Major Course: ${baseCode} — ${course.name}`;
  } else {
    document.getElementById('mapping-course-title').textContent = `${baseCode} (Group ${course.group || ''}) — ${course.name}`;
  }

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
          if (isSingleSelect) {
            container.querySelectorAll('input').forEach(cb => {
              if (cb !== e.target) cb.checked = false;
            });
            currentMapped.length = 0;
          }
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

// -------------------------------------------------------------
// Period Times Config Helpers
// -------------------------------------------------------------
async function loadPeriodTimes() {
  try {
    const res = await fetch(`${API_BASE}/admin/period-times`);
    if (res.ok) {
      const times = await res.json();
      for (let p = 1; p <= 7; p++) {
        const input = document.getElementById(`pt-${p}`);
        if (input) {
          input.value = times[p] || '';
        }
      }
    }
  } catch (err) {
    console.error('Failed to load period times:', err);
  }
}

// -------------------------------------------------------------
// Major / Single Batch Course Allocation Helpers
// -------------------------------------------------------------
function getRecommendedBatchForCourse(course) {
  // Building blocks: {ProgramType}{FundingType(default Aided '1')}{DeptCode}{Year(derived from Semester)}
  const program = course.programType || 'UG';
  const programCode = program === 'PG' ? 'P' : (program === 'INT' ? 'I' : 'U');
  const fundingCode = '1'; // Default to Aided '1'

  // Department Code Map Lookup
  const mapping = state.batchDeptMappings.find(m => m.deptName.toUpperCase() === course.department.toUpperCase());
  if (!mapping) return null;
  const deptCode = mapping.code;

  // Year from Sem Map
  const semInt = parseInt(course.semester);
  let year = null;
  if (state.batchConfig && state.batchConfig.yearSemMap) {
    Object.keys(state.batchConfig.yearSemMap).forEach(yr => {
      const sems = state.batchConfig.yearSemMap[yr] || [];
      if (sems.includes(semInt)) {
        year = yr;
      }
    });
  }
  if (!year) return null;

  return `${programCode}${fundingCode}${deptCode}${year}`;
}

function renderMajorAllocations() {
  const tbody = document.querySelector('#table-major-allocations tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const majorCourses = state.courses.filter(c => !c.group || c.group === 0);
  if (majorCourses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No major courses found.</td></tr>';
    return;
  }

  majorCourses.forEach(c => {
    const recBatch = getRecommendedBatchForCourse(c);
    const assignedBatches = state.groupMappings[c.code] || [];
    const currentSelection = assignedBatches.length > 0 ? assignedBatches[0] : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.code}</strong></td>
      <td>${c.name}</td>
      <td><span class="badge badge-info">${c.semester} Sem</span></td>
      <td><span class="text-sm text-muted">${c.department}</span></td>
      <td><span class="badge badge-outline">${c.programType || 'UG'}</span></td>
      <td>
        ${recBatch ? `<span class="badge badge-success-light text-success">${recBatch}</span>` : '<span class="text-muted text-sm">N/A</span>'}
      </td>
      <td>
        <button class="btn btn-outline btn-sm btn-major-select-batch-trigger" style="font-weight:600; font-size:12px; min-width: 140px; ${!currentSelection ? 'border-color: var(--danger); color: var(--danger);' : ''}">
          ${currentSelection || '-- Click to Select --'}
        </button>
      </td>
      <td>
        <button class="btn btn-outline-danger btn-sm btn-clear-major-mapping" style="padding: 2px 8px;" title="Clear Assignment"><i class="fa-solid fa-eraser"></i> Clear</button>
      </td>
    `;

    // Click trigger to open searchable modal
    tr.querySelector('.btn-major-select-batch-trigger').addEventListener('click', () => {
      const initialMap = currentSelection ? [currentSelection] : (recBatch ? [recBatch] : []);
      openGroupMappingModal(c, initialMap, true);
    });

    // Clear mapping button
    tr.querySelector('.btn-clear-major-mapping').addEventListener('click', async () => {
      if (!currentSelection) return;
      try {
        const res = await fetch(`${API_BASE}/admin/group-mappings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseCode: c.code,
            batches: []
          })
        });
        if (res.ok) {
          state.groupMappings[c.code] = [];
          renderMajorAllocations();
          renderBatchAllocationStatus();
        } else {
          showModalAlert('Error', 'Failed to clear mapping.', 'danger');
        }
      } catch (err) {
        showModalAlert('Error', 'Connection error.', 'danger');
      }
    });

    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------
// Batch Allocation Status Helpers
// -------------------------------------------------------------
function renderBatchAllocationStatus() {
  const tbody = document.querySelector('#table-batch-allocation-status tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const batches = state.allBatches || [];
  if (batches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No batches generated yet. Configure department codes and batch settings.</td></tr>';
    return;
  }

  const sortedBatches = [...batches].sort((a, b) => a.batchId.localeCompare(b.batchId));

  sortedBatches.forEach(b => {
    const assignedCourses = state.courses.filter(c => {
      const mapped = state.groupMappings[c.code] || [];
      return mapped.includes(b.batchId);
    });

    const isAllocated = assignedCourses.length > 0;
    const semStr = b.semesters ? `Sems ${b.semesters.join(',')}` : '';
    
    // Resolve program and funding labels to prevent undefined
    const progLabel = (state.batchConfig.programTypes && state.batchConfig.programTypes[b.prog]) || b.prog || 'UG';
    const fundLabel = (state.batchConfig.fundingTypes && state.batchConfig.fundingTypes[b.fund]) || b.fund || 'Aided';
    const details = `<span class="text-xs text-muted">${progLabel} | ${fundLabel} | ${b.deptName} (${semStr})</span>`;

    const coursesListHtml = isAllocated
      ? assignedCourses.map(c => `<span class="badge badge-info" style="margin-right:4px;" title="${c.name}">${c.code}</span>`).join('')
      : '<span class="text-muted text-sm">None</span>';

    const statusPill = isAllocated
      ? '<span class="badge badge-success">Allocated</span>'
      : '<span class="badge badge-danger">Not Allocated</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${b.batchId}</strong></td>
      <td>${details}</td>
      <td>${coursesListHtml}</td>
      <td>${statusPill}</td>
      <td>
        <button class="btn btn-outline-danger btn-sm btn-delete-batch-status" style="padding: 2px 8px;" title="Exclude Batch"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    `;

    tr.querySelector('.btn-delete-batch-status').addEventListener('click', () => {
      showModalConfirm(
        'Exclude Batch?',
        `Are you sure you want to delete/exclude batch '${b.batchId}'? This will remove it from all selectors.`,
        async () => {
          try {
            const res = await fetch(`${API_BASE}/admin/batches/exclude`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ batchId: b.batchId })
            });
            if (res.ok) {
              const bRes = await fetch(`${API_BASE}/batches`);
              state.allBatches = await bRes.json();
              renderBatchPreview();
              renderBatchAllocationStatus();
              renderMajorAllocations();
            } else {
              showModalAlert('Error', 'Failed to exclude batch.', 'danger');
            }
          } catch (err) {
            showModalAlert('Error', 'Connection error.', 'danger');
          }
        }
      );
    });

    tbody.appendChild(tr);
  });
}

function populateExportPreviewDropdown() {
  const select = document.getElementById('export-preview-batch-select');
  if (!select) return;

  const currentSelection = select.value;
  select.innerHTML = '<option value="">-- Select Batch to Preview --</option>';

  const batches = state.allBatches || [];
  const allocatedBatches = batches.filter(b => {
    return state.courses.some(c => {
      const mapped = state.groupMappings[c.code] || [];
      return mapped.includes(b.batchId);
    });
  });

  const sorted = [...allocatedBatches].sort((a, b) => a.batchId.localeCompare(b.batchId));
  sorted.forEach(b => {
    const isSel = (b.batchId === currentSelection) ? 'selected' : '';
    select.innerHTML += `<option value="${b.batchId}" ${isSel}>${b.batchId} — ${b.batchLabel || b.deptName}</option>`;
  });

  if (currentSelection && allocatedBatches.some(b => b.batchId === currentSelection)) {
    renderBatchTimetablePreview(currentSelection);
  } else {
    select.value = '';
    renderBatchTimetablePreview('');
  }
}

function renderBatchTimetablePreview(batchId) {
  const container = document.getElementById('export-preview-grid-container');
  if (!container) return;

  if (!batchId) {
    container.innerHTML = '<p class="text-muted text-sm text-center py-4">Please select a batch to preview its timetable.</p>';
    return;
  }

  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const periods = ["1", "2", "3", "4", "5", "6", "7"];

  const mappedCourses = state.courses.filter(c => {
    const assigned = state.groupMappings[c.code] || [];
    return assigned.includes(batchId);
  });

  let html = `
    <table class="table table-bordered text-center" style="font-size:12px; margin-top:10px; table-layout: fixed;">
      <thead>
        <tr style="background:var(--surface-2);">
          <th style="width: 100px;">Day</th>
          ${periods.map(p => `<th>Period ${p}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  weekdays.forEach(day => {
    html += `<tr><td style="font-weight:bold; background:var(--surface-1);">${day}</td>`;
    
    periods.forEach(p => {
      const staffList = [];
      const subjectList = [];
      let roomNo = "";

      mappedCourses.forEach(course => {
        Object.entries(state.allocations || {}).forEach(([dept, deptAlloc]) => {
          if (deptAlloc[course.code] && deptAlloc[course.code][day]) {
            const pAlloc = deptAlloc[course.code][day][p];
            if (Array.isArray(pAlloc) && pAlloc.length > 0) {
              pAlloc.forEach(fac => {
                const fObj = state.faculty.find(f => f.code === fac);
                const nameLabel = fObj ? fObj.name : fac;
                if (!staffList.includes(nameLabel)) {
                  staffList.push(nameLabel);
                }
              });
              if (!subjectList.includes(course.code)) {
                subjectList.push(course.code.replace(/_G\d+$/, ''));
              }
              if (course.roomNo) {
                roomNo = course.roomNo;
              }
            }
          }
        });
      });

      if (subjectList.length > 0) {
        html += `
          <td style="background: var(--primary-muted-light, #f0f7ff); padding: 6px;">
            <div style="font-weight:600; color:var(--primary);">${subjectList.join(', ')}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${staffList.join(', ')}</div>
            ${roomNo ? `<div style="font-size:10px; font-weight:bold; color:var(--accent-dark); margin-top:2px;"><i class="fa-solid fa-location-dot"></i> ${roomNo}</div>` : ''}
          </td>
        `;
      } else {
        html += `<td style="color:var(--text-muted); font-size:11px;">—</td>`;
      }
    });

    html += '</tr>';
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// -------------------------------------------------------------
// Common College Global Locks Handlers
// -------------------------------------------------------------
let localGlobalLocks = [];

async function loadGlobalLocks() {
  try {
    const token = sessionStorage.getItem('adminToken') || 'admin-token';
    const res = await fetch(`${API_BASE}/admin/global-locked-periods`, {
      headers: { 'Authorization': token }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        localGlobalLocks = data;
        if (state.config) state.config.globalLockedPeriods = JSON.parse(JSON.stringify(data));
      }
    } else if (state.config && Array.isArray(state.config.globalLockedPeriods)) {
      localGlobalLocks = JSON.parse(JSON.stringify(state.config.globalLockedPeriods));
    }
  } catch (e) {
    console.error('Failed to load global locks:', e);
    if (state.config && Array.isArray(state.config.globalLockedPeriods)) {
      localGlobalLocks = JSON.parse(JSON.stringify(state.config.globalLockedPeriods));
    }
  }
}

function renderGlobalLocksGrid() {
  const table = document.getElementById('table-global-locks-grid');
  if (!table) return;
  
  const rawPeriods = (state.config && state.config.periods) || ['1', '2', '3', 'LB', '4', '5', '6'];
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  const countBadge = document.getElementById('global-locks-count-badge');
  if (countBadge) {
    countBadge.textContent = `${localGlobalLocks.length} period${localGlobalLocks.length === 1 ? '' : 's'} locked`;
  }
  
  let headerHtml = '<tr><th style="width: 140px; text-align: center;">Weekday</th>';
  rawPeriods.forEach(p => {
    if (String(p).toUpperCase() === 'LB') {
      headerHtml += `<th style="width: 70px; text-align: center; background-color: var(--background); color: var(--text-muted); font-size: 11px;">Lunch</th>`;
    } else {
      headerHtml += `<th style="text-align: center;">Period ${p}</th>`;
    }
  });
  headerHtml += '</tr>';
  thead.innerHTML = headerHtml;
  
  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const nonLbPeriods = rawPeriods.filter(p => String(p).trim().toUpperCase() !== 'LB').map(p => String(p).trim());
  let bodyHtml = '';
  
  weekdays.forEach(day => {
    const lockedCountForDay = nonLbPeriods.filter(pStr => 
      localGlobalLocks.some(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === pStr)
    ).length;
    const isEntireDayLocked = lockedCountForDay === nonLbPeriods.length;

    bodyHtml += `<tr>
      <td style="font-weight: 700; text-align: center; background-color: var(--background); vertical-align: middle; padding: 6px 8px;">
        <div style="font-size: 13px; margin-bottom: 4px;">${day}</div>
        <button type="button" class="btn btn-xs ${isEntireDayLocked ? 'btn-outline text-danger' : 'btn-outline'} btn-day-lock-toggle" data-day="${day}" style="font-size: 10px; padding: 2px 6px; white-space: nowrap; width: 100%; border-radius: 4px;" title="${isEntireDayLocked ? `Unlock all periods on ${day}` : `Lock all periods on ${day}`}">
          <i class="fa-solid ${isEntireDayLocked ? 'fa-lock-open' : 'fa-lock'}"></i> ${isEntireDayLocked ? 'Unlock Day' : 'Lock Day'}
        </button>
      </td>`;
    
    rawPeriods.forEach(p => {
      const pStr = String(p).trim();
      if (pStr.toUpperCase() === 'LB') {
        bodyHtml += `<td style="background-color: var(--background); color: var(--text-muted); font-weight: 600; font-size: 11px;">LB</td>`;
      } else {
        const matchingLocks = localGlobalLocks.filter(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === pStr);
        
        if (matchingLocks.length > 0) {
          const isAll = matchingLocks.some(l => !l.semester || l.semester === 'all');
          let badgeContent = '';

          if (isAll) {
            const allLock = matchingLocks.find(l => !l.semester || l.semester === 'all');
            const lbl = (allLock && allLock.label) ? allLock.label : 'LOCKED';
            badgeContent = `
              <span style="font-size: 11px; max-width: 95px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700;">${lbl}</span>
              <span class="badge" style="font-size: 9px; padding: 1px 4px; background: #dc2626; color: white;">All Sems</span>
            `;
          } else {
            badgeContent = `
              <div style="display: flex; flex-direction: column; gap: 2px; width: 100%;">
                ${matchingLocks.map(m => `
                  <div style="font-size: 10px; background: #fee2e2; border: 1px solid #f87171; border-radius: 3px; padding: 1px 3px; display: flex; justify-content: space-between; align-items: center; gap: 4px;">
                    <span style="font-weight: 700; color: #991b1b; white-space: nowrap;">S${m.semester}:</span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 65px; color: #7f1d1d;" title="${m.label || ''}">${m.label || 'Locked'}</span>
                  </div>
                `).join('')}
              </div>
            `;
          }

          bodyHtml += `
            <td class="global-lock-cell locked" data-day="${day}" data-period="${pStr}" title="${matchingLocks.map(m => `${m.semester ? `Sem ${m.semester}` : 'All Sems'}: ${m.label}`).join(' | ')}" style="cursor: pointer; background-color: #fef2f2; border: 1.5px solid #ef4444; color: #b91c1c; padding: 6px 4px; transition: all 0.2s;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
                <i class="fa-solid fa-lock" style="font-size: 12px;"></i>
                ${badgeContent}
              </div>
            </td>`;
        } else {
          bodyHtml += `
            <td class="global-lock-cell open" data-day="${day}" data-period="${pStr}" title="Click to lock this period" style="cursor: pointer; background-color: var(--surface); padding: 10px 4px; transition: all 0.2s;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--text-muted); opacity: 0.6;">
                <i class="fa-regular fa-circle" style="font-size: 14px;"></i>
                <span style="font-size: 10px;">Available</span>
              </div>
            </td>`;
        }
      }
    });
    
    bodyHtml += '</tr>';
  });
  tbody.innerHTML = bodyHtml;
  
  table.querySelectorAll('.global-lock-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const day = cell.getAttribute('data-day');
      const period = cell.getAttribute('data-period');
      openGlobalLockModal(day, period);
    });
  });

  table.querySelectorAll('.btn-day-lock-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const day = btn.getAttribute('data-day');
      const defaultGlobalLabel = (document.getElementById('global-lock-default-label') && document.getElementById('global-lock-default-label').value.trim()) || 'College Assembly / Common Hour';
      const nonLbPeriods = rawPeriods.filter(p => String(p).trim().toUpperCase() !== 'LB').map(p => String(p).trim());
      const lockedCountForDay = nonLbPeriods.filter(pStr => 
        localGlobalLocks.some(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === pStr)
      ).length;
      const isEntireDayLocked = lockedCountForDay === nonLbPeriods.length;

      if (isEntireDayLocked) {
        localGlobalLocks = localGlobalLocks.filter(l => l.day.toUpperCase() !== day.toUpperCase());
      } else {
        nonLbPeriods.forEach(p => {
          localGlobalLocks = localGlobalLocks.filter(l => !(l.day.toUpperCase() === day.toUpperCase() && String(l.period) === String(p)));
          localGlobalLocks.push({ day, period: p, label: defaultGlobalLabel, semester: 'all' });
        });
      }

      if (state.config) state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
      renderGlobalLocksGrid();

      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        const alertBox = document.getElementById('global-locks-alert');
        if (alertBox) {
          alertBox.textContent = isEntireDayLocked ? `Unlocked all periods for ${day}.` : `Locked all periods for ${day}.`;
          alertBox.classList.remove('hidden');
          setTimeout(() => alertBox.classList.add('hidden'), 3500);
        }
      } catch (err) {
        console.error('Failed to update day lock:', err);
      }
    });
  });
}

function getSemesterLabelOptions(semVal) {
  const semStr = String(semVal || '').toLowerCase();
  if (semStr === '1') {
    return ['MDC1', 'AEC1', 'AEC2', 'Other'];
  } else if (semStr === '2') {
    return ['MDC-2', 'AEC3', 'AEC4', 'Other'];
  } else if (semStr === '3') {
    return ['VAC1', 'MDC3', 'Other'];
  } else if (semStr === '4') {
    return ['VAC2', 'SEC', 'VAC3', 'Other'];
  } else if (semStr === 'all') {
    return ['College Activity', 'Assembly', 'Exam', 'Other'];
  } else {
    return ['College Activity', 'Assembly', 'Exam', 'Other'];
  }
}

function createLockSemRowHtml(semVal = 'all', labelVal = '') {
  const sems = ['1', '2', '3', '4', '5', '6'];
  const opts = getSemesterLabelOptions(semVal);
  const isPredefined = opts.includes(labelVal) && labelVal !== 'Other';
  const selectedOpt = isPredefined ? labelVal : (labelVal ? 'Other' : opts[0]);
  const customValue = (selectedOpt === 'Other') ? labelVal : '';

  return `
    <div class="lock-sem-row flex-row items-center gap-2" style="background: var(--background); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
      <div style="flex: 0 0 130px;">
        <label class="text-xs text-muted bold" style="display: block; margin-bottom: 2px;">Select Sem</label>
        <select class="form-control form-control-sm lock-row-sem-select" style="font-size: 12px; height: 32px;">
          <option value="all" ${semVal === 'all' || !semVal ? 'selected' : ''}>All Semesters</option>
          ${sems.map(s => `<option value="${s}" ${String(semVal) === s ? 'selected' : ''}>Semester ${s}</option>`).join('')}
        </select>
      </div>
      <div style="flex: 0 0 130px;">
        <label class="text-xs text-muted bold" style="display: block; margin-bottom: 2px;">Subject Option</label>
        <select class="form-control form-control-sm lock-row-label-select" style="font-size: 12px; height: 32px;">
          ${opts.map(o => `<option value="${o}" ${o === selectedOpt ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
      <div style="flex: 1;">
        <label class="text-xs text-muted bold" style="display: block; margin-bottom: 2px;">Custom / Label Name</label>
        <input type="text" class="form-control form-control-sm lock-row-label-input" placeholder="Type custom name" style="font-size: 12px; height: 32px;" value="${customValue ? customValue.replace(/"/g, '&quot;') : (selectedOpt !== 'Other' ? selectedOpt : '')}" ${selectedOpt !== 'Other' ? 'disabled' : ''}>
      </div>
      <div style="flex: 0 0 32px; padding-top: 16px;">
        <button type="button" class="btn btn-outline btn-xs btn-remove-lock-row" style="color: var(--danger); border-color: #fca5a5; height: 32px; width: 32px; display: flex; align-items: center; justify-content: center;" title="Remove this semester lock">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
  `;
}

function updateAddOtherSemVisibility() {
  const container = document.getElementById('modal-lock-rows-container');
  const addWrapper = document.getElementById('wrapper-add-lock-sem-row');
  if (!container || !addWrapper) return;
  
  const rows = container.querySelectorAll('.lock-sem-row');
  let hasAll = false;
  rows.forEach(r => {
    const sel = r.querySelector('.lock-row-sem-select');
    if (sel && sel.value === 'all') hasAll = true;
  });

  if (hasAll) {
    addWrapper.style.display = 'none';
  } else {
    addWrapper.style.display = 'block';
  }
}

function bindLockRowEvents(rowEl) {
  const semSel = rowEl.querySelector('.lock-row-sem-select');
  const labelSel = rowEl.querySelector('.lock-row-label-select');
  const labelInput = rowEl.querySelector('.lock-row-label-input');
  const removeBtn = rowEl.querySelector('.btn-remove-lock-row');
  const container = document.getElementById('modal-lock-rows-container');

  const updateLabelOptionsForSem = () => {
    const sem = semSel.value;
    const opts = getSemesterLabelOptions(sem);
    const curVal = labelSel.value;
    labelSel.innerHTML = opts.map(o => `<option value="${o}">${o}</option>`).join('');
    if (opts.includes(curVal)) {
      labelSel.value = curVal;
    } else {
      labelSel.value = opts[0];
    }
    handleLabelSelectChange();
    updateAddOtherSemVisibility();
  };

  const handleLabelSelectChange = () => {
    if (labelSel.value === 'Other') {
      labelInput.disabled = false;
      labelInput.placeholder = 'Type custom activity name';
      const allKnownSubjects = ['MDC1', 'AEC1', 'AEC2', 'MDC-2', 'AEC3', 'AEC4', 'VAC1', 'MDC3', 'VAC2', 'SEC', 'VAC3', 'College Activity', 'Assembly', 'Exam'];
      if (allKnownSubjects.includes(labelInput.value)) {
        labelInput.value = '';
      }
      labelInput.focus();
    } else {
      labelInput.value = labelSel.value;
      labelInput.disabled = true;
    }
  };

  if (semSel) {
    semSel.addEventListener('change', updateLabelOptionsForSem);
  }

  if (labelSel) {
    labelSel.addEventListener('change', handleLabelSelectChange);
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const allRows = container.querySelectorAll('.lock-sem-row');
      if (allRows.length <= 1) {
        semSel.value = 'all';
        updateLabelOptionsForSem();
      } else {
        rowEl.remove();
      }
      updateAddOtherSemVisibility();
    });
  }
}

function openGlobalLockModal(day, period) {
  const modal = document.getElementById('modal-edit-global-lock');
  const dayPeriodSpan = document.getElementById('modal-lock-day-period');
  const dayInput = document.getElementById('modal-lock-target-day');
  const periodInput = document.getElementById('modal-lock-target-period');
  const container = document.getElementById('modal-lock-rows-container');
  const unlockBtn = document.getElementById('btn-modal-unlock-period');
  const defaultGlobalLabel = (document.getElementById('global-lock-default-label') && document.getElementById('global-lock-default-label').value.trim()) || 'College Assembly / Mentor Hour';

  if (!modal || !container) return;

  dayInput.value = day;
  periodInput.value = period;

  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const matchingLocks = localGlobalLocks.filter(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === String(period));

  // Determine which weekdays currently share this lock configuration
  let initialDays = [day.toUpperCase()];
  if (matchingLocks.length > 0) {
    const lockSig = matchingLocks.map(l => `${l.semester || 'all'}:${(l.label || '').trim()}`).sort().join('|');
    const sameSigDays = weekdays.filter(d => {
      const dLocks = localGlobalLocks.filter(l => l.day.toUpperCase() === d && String(l.period) === String(period));
      const dSig = dLocks.map(l => `${l.semester || 'all'}:${(l.label || '').trim()}`).sort().join('|');
      return dSig === lockSig && lockSig !== '';
    });
    if (sameSigDays.length > 0) {
      initialDays = sameSigDays;
    }
  }

  modal.setAttribute('data-init-days', JSON.stringify(initialDays));

  // Set day checkboxes
  const dayCbs = modal.querySelectorAll('.lock-day-cb');
  dayCbs.forEach(cb => {
    cb.checked = initialDays.includes(cb.value.toUpperCase());
  });

  const updateModalDayTitle = () => {
    const checkedDays = Array.from(modal.querySelectorAll('.lock-day-cb:checked')).map(cb => cb.value.toUpperCase());
    let dayText = day;
    if (checkedDays.length === 5) {
      dayText = 'All Weekdays';
    } else if (checkedDays.length > 0) {
      dayText = checkedDays.map(v => v.charAt(0) + v.slice(1, 3).toLowerCase()).join(', ');
    } else {
      dayText = 'No days selected';
    }
    if (dayPeriodSpan) dayPeriodSpan.textContent = `${dayText} - Period ${period}`;
  };
  updateModalDayTitle();

  dayCbs.forEach(cb => {
    cb.onchange = updateModalDayTitle;
  });

  container.innerHTML = '';
  if (matchingLocks.length > 0) {
    matchingLocks.forEach(l => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = createLockSemRowHtml(l.semester || 'all', l.label || '');
      const el = wrapper.firstElementChild;
      container.appendChild(el);
      bindLockRowEvents(el);
    });
    if (unlockBtn) unlockBtn.classList.remove('hidden');
  } else {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = createLockSemRowHtml('all', defaultGlobalLabel);
    const el = wrapper.firstElementChild;
    container.appendChild(el);
    bindLockRowEvents(el);
    if (unlockBtn) unlockBtn.classList.add('hidden');
  }

  updateAddOtherSemVisibility();
  modal.classList.remove('hidden');
}

function closeGlobalLockModal() {
  const modal = document.getElementById('modal-edit-global-lock');
  if (modal) modal.classList.add('hidden');
}

function bindGlobalLocksEvents() {
  const btnSave = document.getElementById('btn-save-global-locks');
  const btnClear = document.getElementById('btn-clear-global-locks');
  const alertBox = document.getElementById('global-locks-alert');
  
  const modal = document.getElementById('modal-edit-global-lock');
  const btnCloseModal = document.getElementById('btn-close-lock-modal');
  const btnCancelModal = document.getElementById('btn-modal-cancel-lock');
  const btnSaveModal = document.getElementById('btn-modal-save-lock');
  const btnUnlockModal = document.getElementById('btn-modal-unlock-period');
  const btnAddRow = document.getElementById('btn-add-lock-sem-row');
  const container = document.getElementById('modal-lock-rows-container');

  // Day buttons inside modal
  const btnLockDaysAll = document.getElementById('btn-lock-days-all');
  const btnLockDaysCurrent = document.getElementById('btn-lock-days-current');
  if (btnLockDaysAll && modal) {
    btnLockDaysAll.addEventListener('click', () => {
      const dayCbs = modal.querySelectorAll('.lock-day-cb');
      dayCbs.forEach(cb => { cb.checked = true; });
      if (dayCbs.length > 0 && dayCbs[0].onchange) dayCbs[0].onchange();
    });
  }
  if (btnLockDaysCurrent && modal) {
    btnLockDaysCurrent.addEventListener('click', () => {
      const curDay = (document.getElementById('modal-lock-target-day').value || '').toUpperCase();
      const dayCbs = modal.querySelectorAll('.lock-day-cb');
      dayCbs.forEach(cb => {
        cb.checked = (cb.value.toUpperCase() === curDay);
      });
      if (dayCbs.length > 0 && dayCbs[0].onchange) dayCbs[0].onchange();
    });
  }

  // Quick toolbar day lock controls
  const btnQuickDayLock = document.getElementById('btn-apply-quick-day-lock');
  const btnQuickDayUnlock = document.getElementById('btn-apply-quick-day-unlock');
  const selectQuickDay = document.getElementById('select-quick-day-lock');

  if (btnQuickDayLock) {
    btnQuickDayLock.addEventListener('click', async () => {
      const selectedDay = selectQuickDay ? selectQuickDay.value : '';
      if (!selectedDay) {
        showAdminAlert('Day Selection Required', 'Please select a day or All Weekdays from the dropdown.', 'warning');
        return;
      }

      const defaultGlobalLabel = (document.getElementById('global-lock-default-label') && document.getElementById('global-lock-default-label').value.trim()) || 'College Assembly / Common Hour';
      const rawPeriods = (state.config && state.config.periods) || ['1', '2', '3', 'LB', '4', '5', '6'];
      const nonLbPeriods = rawPeriods.filter(p => String(p).trim().toUpperCase() !== 'LB').map(p => String(p).trim());
      const targetDays = selectedDay === 'ALL' ? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] : [selectedDay];

      targetDays.forEach(d => {
        nonLbPeriods.forEach(p => {
          localGlobalLocks = localGlobalLocks.filter(l => !(l.day.toUpperCase() === d.toUpperCase() && String(l.period) === String(p)));
          localGlobalLocks.push({ day: d, period: p, label: defaultGlobalLabel, semester: 'all' });
        });
      });

      if (state.config) state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
      renderGlobalLocksGrid();

      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        if (alertBox) {
          alertBox.textContent = `Successfully locked all periods for ${selectedDay === 'ALL' ? 'all weekdays' : selectedDay}.`;
          alertBox.classList.remove('hidden');
          setTimeout(() => alertBox.classList.add('hidden'), 3500);
        }
      } catch (e) {
        console.error('Failed to autosave day lock:', e);
      }
    });
  }

  if (btnQuickDayUnlock) {
    btnQuickDayUnlock.addEventListener('click', async () => {
      const selectedDay = selectQuickDay ? selectQuickDay.value : '';
      if (!selectedDay) {
        showAdminAlert('Day Selection Required', 'Please select a day or All Weekdays from the dropdown.', 'warning');
        return;
      }

      const targetDays = selectedDay === 'ALL' ? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] : [selectedDay];

      targetDays.forEach(d => {
        localGlobalLocks = localGlobalLocks.filter(l => l.day.toUpperCase() !== d.toUpperCase());
      });

      if (state.config) state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
      renderGlobalLocksGrid();

      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        if (alertBox) {
          alertBox.textContent = `Successfully unlocked all periods for ${selectedDay === 'ALL' ? 'all weekdays' : selectedDay}.`;
          alertBox.classList.remove('hidden');
          setTimeout(() => alertBox.classList.add('hidden'), 3500);
        }
      } catch (e) {
        console.error('Failed to autosave day unlock:', e);
      }
    });
  }

  if (btnCloseModal) btnCloseModal.addEventListener('click', closeGlobalLockModal);
  if (btnCancelModal) btnCancelModal.addEventListener('click', closeGlobalLockModal);

  // Add Other Sem button
  if (btnAddRow) {
    btnAddRow.addEventListener('click', () => {
      if (!container) return;

      // Find used semesters
      const usedSems = new Set();
      container.querySelectorAll('.lock-row-sem-select').forEach(s => usedSems.add(s.value));

      // Pick next unused semester
      const allSems = ['1', '2', '3', '4', '5', '6'];
      const nextSem = allSems.find(s => !usedSems.has(s)) || '1';

      const wrapper = document.createElement('div');
      wrapper.innerHTML = createLockSemRowHtml(nextSem, '');
      const el = wrapper.firstElementChild;
      container.appendChild(el);
      bindLockRowEvents(el);

      updateAddOtherSemVisibility();
      const input = el.querySelector('.lock-row-label-input');
      if (input) input.focus();
    });
  }

  // Modal Save Lock button
  if (btnSaveModal) {
    btnSaveModal.addEventListener('click', async () => {
      const initialDay = (document.getElementById('modal-lock-target-day').value || '').toUpperCase();
      const period = document.getElementById('modal-lock-target-period').value;
      if (!container) return;

      const checkedDayBoxes = Array.from(modal.querySelectorAll('.lock-day-cb:checked'));
      const selectedDays = checkedDayBoxes.length > 0 ? checkedDayBoxes.map(cb => cb.value.toUpperCase()) : [initialDay];

      let initDays = [];
      try {
        initDays = JSON.parse(modal.getAttribute('data-init-days') || '[]');
      } catch (e) {
        initDays = [initialDay];
      }

      const rows = container.querySelectorAll('.lock-sem-row');
      const rowConfigs = [];

      rows.forEach(r => {
        const sem = r.querySelector('.lock-row-sem-select').value;
        const labelSel = r.querySelector('.lock-row-label-select');
        const labelInput = r.querySelector('.lock-row-label-input');
        let label = 'College Activity';
        if (labelSel && labelSel.value !== 'Other') {
          label = labelSel.value;
        } else if (labelInput) {
          label = labelInput.value.trim() || 'College Activity';
        }
        rowConfigs.push({ sem, label });
      });

      if (rowConfigs.length === 0) {
        closeGlobalLockModal();
        return;
      }

      // 1. Remove locks from any day that was originally part of this lock group but is now unchecked
      const unselectedDays = initDays.filter(d => !selectedDays.includes(d));
      unselectedDays.forEach(d => {
        localGlobalLocks = localGlobalLocks.filter(l => !(l.day.toUpperCase() === d && String(l.period) === String(period)));
      });

      // 2. Apply the lock to all selected days
      selectedDays.forEach(day => {
        // Remove existing locks for this day and period
        localGlobalLocks = localGlobalLocks.filter(l => !(l.day.toUpperCase() === day.toUpperCase() && String(l.period) === String(period)));

        // If any row is 'all', only keep the 'all' lock
        const allLock = rowConfigs.find(rc => rc.sem === 'all');
        if (allLock) {
          localGlobalLocks.push({ day, period, label: allLock.label, semester: 'all' });
        } else {
          // Prevent duplicate semester entries
          const addedSems = new Set();
          rowConfigs.forEach(rc => {
            if (!addedSems.has(rc.sem)) {
              addedSems.add(rc.sem);
              localGlobalLocks.push({ day, period, label: rc.label, semester: rc.sem });
            }
          });
        }
      });

      if (state.config) {
        state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
      }

      closeGlobalLockModal();
      renderGlobalLocksGrid();

      // Immediately persist to server so department view sees it instantly
      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        if (alertBox) {
          alertBox.textContent = `Saved Period ${period} lock across ${selectedDays.length} day(s) (${selectedDays.join(', ')}).`;
          alertBox.classList.remove('hidden');
          setTimeout(() => alertBox.classList.add('hidden'), 3500);
        }
      } catch (e) {
        console.error('Failed to autosave global locks:', e);
      }
    });
  }

  // Modal Unlock button
  if (btnUnlockModal) {
    btnUnlockModal.addEventListener('click', async () => {
      const initialDay = (document.getElementById('modal-lock-target-day').value || '').toUpperCase();
      const period = document.getElementById('modal-lock-target-period').value;

      const checkedDayBoxes = Array.from(modal.querySelectorAll('.lock-day-cb:checked'));
      const selectedDays = checkedDayBoxes.length > 0 ? checkedDayBoxes.map(cb => cb.value.toUpperCase()) : [initialDay];

      let initDays = [];
      try {
        initDays = JSON.parse(modal.getAttribute('data-init-days') || '[]');
      } catch (e) {
        initDays = [initialDay];
      }

      const daysToUnlock = Array.from(new Set([...selectedDays, ...initDays, initialDay]));

      daysToUnlock.forEach(day => {
        localGlobalLocks = localGlobalLocks.filter(l => !(l.day.toUpperCase() === day && String(l.period) === String(period)));
      });

      if (state.config) {
        state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
      }

      closeGlobalLockModal();
      renderGlobalLocksGrid();

      // Immediately persist to server so slot is unlocked across all departments
      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        const res = await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        if (res.ok) {
          if (alertBox) {
            alertBox.textContent = `Unlocked Period ${period} across ${daysToUnlock.join(', ')}.`;
            alertBox.classList.remove('hidden');
            setTimeout(() => alertBox.classList.add('hidden'), 3500);
          }
        }
      } catch (e) {
        console.error('Failed to autosave global locks on unlock:', e);
      }
    });
  }


  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      try {
        const token = sessionStorage.getItem('adminToken') || 'admin-token';
        const res = await fetch(`${API_BASE}/admin/global-locked-periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': token },
          body: JSON.stringify({ locks: localGlobalLocks })
        });
        const result = await res.json();
        if (res.ok) {
          if (state.config) {
            state.config.globalLockedPeriods = JSON.parse(JSON.stringify(localGlobalLocks));
          }
          if (alertBox) {
            alertBox.textContent = `Saved ${localGlobalLocks.length} global locked period(s) successfully.`;
            alertBox.classList.remove('hidden');
            setTimeout(() => alertBox.classList.add('hidden'), 3500);
          }
          renderGlobalLocksGrid();
          showModalAlert('Success', 'Global locked periods saved successfully.', 'success');
          await fetchGlobalData();
          renderGlobalLocksGrid();
        } else {
          showModalAlert('Error', result.message || 'Failed to save global locks.', 'danger');
        }
      } catch (err) {
        showModalAlert('Error', 'Connection error.', 'danger');
      }
    });
  }
  
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      showModalConfirm('Clear All Locks', 'Are you sure you want to clear all global locked periods? This will immediately unlock all periods across all departments.', async () => {
        localGlobalLocks = [];
        if (state.config) {
          state.config.globalLockedPeriods = [];
        }
        renderGlobalLocksGrid();

        // Immediately persist to server so all department slots are unlocked
        try {
          const token = sessionStorage.getItem('adminToken') || 'admin-token';
          const res = await fetch(`${API_BASE}/admin/global-locked-periods`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': token },
            body: JSON.stringify({ locks: [] })
          });
          const result = await res.json();
          if (res.ok) {
            if (alertBox) {
              alertBox.textContent = 'All global locked periods cleared and unlocked across all departments.';
              alertBox.classList.remove('hidden');
              setTimeout(() => alertBox.classList.add('hidden'), 3500);
            }
            showModalAlert('All Locks Cleared', 'All global locked periods have been cleared and unlocked across all departments.', 'success');
            await fetchGlobalData();
            renderGlobalLocksGrid();
          } else {
            showModalAlert('Error', result.message || 'Failed to clear global locks on server.', 'danger');
          }
        } catch (e) {
          console.error('Failed to clear global locks:', e);
          showModalAlert('Error', 'Connection error while clearing global locks.', 'danger');
        }
      });
    });
  }
}

