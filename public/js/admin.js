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
    const token = sessionStorage.getItem('adminToken') || '';
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
  subjectTeacherMapping: {},
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
    const dept = document.getElementById('edit-course-dept').value;
    const name = document.getElementById('edit-course-name').value.trim();
    const programType = document.getElementById('edit-course-program')?.value || 'UG';
    const alias = document.getElementById('edit-course-alias').value.trim();
    const classes = parseInt(document.getElementById('edit-course-classes').value, 10) || 1;

    if (!name) {
      showModalAlert('Error', 'Course Name is required.', 'danger');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/admin/courses/${encodeURIComponent(code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, alias, programType, classes, department: dept })
      });
      const result = await res.json();
      if (res.ok) {
        document.getElementById('modal-edit-course').classList.add('hidden');
        showToast('Course details and class split updated successfully.', 'success');
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

    await saveBatchMapping(courseCode, batches, 'Batch mapping saved successfully.');
  });

  // Group Mapping Export CSV
  const btnExportGroupMappings = document.getElementById('btn-export-group-mappings');
  if (btnExportGroupMappings) {
    btnExportGroupMappings.addEventListener('click', () => {
      const groupCourses = state.courses.filter(c => (c.group && c.group > 0) || (c.class && c.class > 0) || (c.classes && c.classes > 1) || /(_G|_C)\d+/.test(c.code));
      const uniq = [];
      groupCourses.forEach(c => {
        if (!uniq.some(uc => uc.code === c.code)) uniq.push(c);
      });

      if (uniq.length === 0) {
        showModalAlert('No Classes', 'There are no class/section courses configured in the database to export.', 'info');
        return;
      }

      let csv = "Course Code,Course Name,Class,Batches\n";
      uniq.forEach(c => {
        const baseCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
        const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 1);
        const mapped = (c.mappedBatches || []).join(',');
        const nameEscaped = `"${c.name.replace(/"/g, '""')}"`;
        const batchesEscaped = `"${mapped.replace(/"/g, '""')}"`;
        csv += `${baseCode},${nameEscaped},${classNum},${batchesEscaped}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", `class_batches_export.csv`);
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
          showToast(result.message || 'Group mappings imported successfully.', 'success');
          await fetchGlobalData();
          renderGroupMappings();
        } else {
          showToast(result.error || 'Failed to import mappings.', 'danger');
        }
      } catch (err) {
        fileInputGroupMappings.value = '';
        showToast('Connection error during upload.', 'danger');
      }
    });
  }

  // Auto-Assign Recommended Batches for Major Courses
  const btnAutoAssignRecMajors = document.getElementById('btn-auto-assign-recommended-majors');
  if (btnAutoAssignRecMajors) {
    btnAutoAssignRecMajors.addEventListener('click', async () => {
      const majorCourses = (state.courses || []).filter(c => !c.group || c.group === 0);
      const updates = {};
      let eligibleCount = 0;

      majorCourses.forEach(c => {
        const rec = getRecommendedBatchForCourse(c);
        if (rec) {
          const current = (state.groupMappings[c.code] && state.groupMappings[c.code][0]) || '';
          if (current !== rec) {
            updates[c.code] = [rec];
            eligibleCount++;
          }
        }
      });

      if (eligibleCount === 0) {
        showToast('All eligible major courses already have their recommended batch assigned.', 'info');
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/admin/group-mappings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings: updates })
        });
        const result = await res.json();
        if (res.ok) {
          // Update in-memory state
          Object.entries(updates).forEach(([code, batches]) => {
            state.groupMappings[code] = batches;
            const baseCode = code.replace(/-(T|P)$/, '');
            state.groupMappings[baseCode] = batches;
            if (Array.isArray(state.courses)) {
              state.courses.forEach(c => {
                const cBase = (c.code || '').replace(/-(T|P)$/, '');
                if (c.code === code || cBase === baseCode) {
                  c.mappedBatches = batches;
                }
              });
            }
          });

          renderMajorAllocations();
          renderGroupMappings();
          renderBatchAllocationStatus();
          renderBatchPreview();
          showToast(`Assigned recommended batches to ${eligibleCount} major course(s).`, 'success');
        } else {
          showToast(result.message || 'Failed to auto-assign batches.', 'danger');
        }
      } catch (err) {
        showToast('Connection error while auto-assigning batches.', 'danger');
      }
    });
  }

  // Major Mapping Export
  const btnExportMajorMappings = document.getElementById('btn-export-major-mappings');
  if (btnExportMajorMappings) {
    btnExportMajorMappings.addEventListener('click', () => {
      const adminToken = sessionStorage.getItem('adminToken') || '';
      if (!adminToken) {
        showToast('Please log in as administrator to export.', 'warning');
        return;
      }
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
          showToast(result.message || 'Major mappings imported successfully.', 'success');
          await fetchGlobalData();
          renderMajorAllocations();
          renderBatchAllocationStatus();
        } else {
          showToast(result.error || 'Failed to import mappings.', 'danger');
        }
      } catch (err) {
        fileInputMajorMappings.value = '';
        showToast('Connection error during upload.', 'danger');
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
  initImportRecordsModal();
  bindCustomModals();
  bindResetDeptPasswordEvents();
  bindGlobalLocksEvents();
  await loadGlobalLocks();
  // Handle Batch Allocation sub-tabs switching
  document.querySelectorAll('#tab-admin-group-mappings .tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-admin-group-mappings .tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetSubtab = btn.getAttribute('data-subtab');
      sessionStorage.setItem('adminBatchAllocSubtab', targetSubtab);
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

  // Handle Common Subject Mapping UI events
  const btnBackCommon = document.getElementById('btn-back-to-admin-common');
  if (btnBackCommon) {
    btnBackCommon.addEventListener('click', () => {
      activeAdminCommonSubjectCode = null;
      renderAdminCommonSubjectMapping();
    });
  }
  const adminCommonSemFilter = document.getElementById('admin-common-sem-filter');
  if (adminCommonSemFilter) {
    adminCommonSemFilter.addEventListener('change', () => {
      renderAdminCommonSubjectMapping();
    });
  }

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
      const adminToken = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
    const savedTab = sessionStorage.getItem('adminActiveTab') || state.currentTab;
    const savedDataSubtab = sessionStorage.getItem('adminDataSubtab');
    if (savedDataSubtab) state.selectedDataSubtab = savedDataSubtab;
    await showTab(savedTab);
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

// Sleek, non-blocking toast notifications (no confirmation button required)
window.showToast = function(message, type = 'info', duration = 3200) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      max-width: 420px;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `custom-toast toast-${type}`;
  toast.style.cssText = `
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
    font-size: 13.5px;
    font-weight: 500;
    line-height: 1.4;
    color: #fff;
    opacity: 0;
    transform: translateY(-12px);
    transition: all 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  let bg = '#1e293b';
  let icon = '<i class="fa-solid fa-circle-info"></i>';
  if (type === 'success') {
    bg = 'linear-gradient(135deg, #059669, #10b981)';
    icon = '<i class="fa-solid fa-circle-check"></i>';
  } else if (type === 'danger' || type === 'error') {
    bg = 'linear-gradient(135deg, #dc2626, #ef4444)';
    icon = '<i class="fa-solid fa-circle-exclamation"></i>';
  } else if (type === 'warning') {
    bg = 'linear-gradient(135deg, #d97706, #f59e0b)';
    icon = '<i class="fa-solid fa-triangle-exclamation"></i>';
  } else {
    bg = 'linear-gradient(135deg, #2563eb, #3b82f6)';
  }
  toast.style.background = bg;

  toast.innerHTML = `
    <span style="font-size: 16px; flex-shrink: 0;">${icon}</span>
    <span style="flex-grow: 1;">${message}</span>
    <button type="button" style="background: transparent; border: none; color: rgba(255,255,255,0.85); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; margin-left: 6px; flex-shrink: 0;" title="Dismiss">&times;</button>
  `;

  const closeBtn = toast.querySelector('button');
  const dismiss = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-12px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  };

  closeBtn.addEventListener('click', dismiss);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(dismiss, duration);
};

// Global Batch Mapping Helper for live UI updates
async function saveBatchMapping(courseCode, batches, successMsg = 'Batch mapping updated successfully.') {
  try {
    const res = await fetch(`${API_BASE}/admin/group-mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseCode, batches })
    });
    const result = await res.json();
    if (res.ok) {
      const modal = document.getElementById('modal-group-mapping');
      if (modal) modal.classList.add('hidden');

      // Update state in memory immediately for live responsiveness
      state.groupMappings[courseCode] = batches;
      const baseCode = courseCode.replace(/-(T|P)$/, '');
      state.groupMappings[baseCode] = batches;
      if (Array.isArray(state.courses)) {
        state.courses.forEach(c => {
          const cBase = (c.code || '').replace(/-(T|P)$/, '');
          if (c.code === courseCode || cBase === baseCode) {
            c.mappedBatches = batches;
          }
        });
      }

      window.showToast(successMsg, 'success');

      // Live UI updates without requiring page refresh
      renderMajorAllocations();
      renderGroupMappings();
      renderBatchAllocationStatus();
      renderBatchPreview();
      if (state.currentTab === 'tab-admin-common-subject-mapping') {
        if (activeAdminCommonSubjectCode) {
          openAdminCommonSubjectDetail(activeAdminCommonSubjectCode);
        } else {
          renderAdminCommonSubjectMapping();
        }
      }
      return true;
    } else {
      window.showToast(result.message || 'Failed to save mapping.', 'danger');
      return false;
    }
  } catch (e) {
    window.showToast('Connection error while saving batch mapping.', 'danger');
    return false;
  }
}
window.saveBatchMapping = saveBatchMapping;

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
    const token = sessionStorage.getItem('adminToken') || '';
    const [configRes, deptsRes, coursesRes, facultyRes, batchDeptsRes, batchCfgRes, groupRes, allBatchesRes, allocationsRes, subjectMappingRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/admin/departments`, { headers: { 'Authorization': token } }),
      fetch(`${API_BASE}/courses`),
      fetch(`${API_BASE}/faculty`),
      fetch(`${API_BASE}/admin/batch-dept-mappings`),
      fetch(`${API_BASE}/admin/batch-config`),
      fetch(`${API_BASE}/admin/group-mappings`),
      fetch(`${API_BASE}/batches`),
      fetch(`${API_BASE}/allocations`),
      fetch(`${API_BASE}/department/subject-mapping`)
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
    state.subjectTeacherMapping = (subjectMappingRes && subjectMappingRes.ok) ? await subjectMappingRes.json() : {};

    if (state.config && Array.isArray(state.config.globalLockedPeriods)) {
      localGlobalLocks = JSON.parse(JSON.stringify(state.config.globalLockedPeriods));
      if (state.currentTab === 'tab-admin-global-locks') {
        renderGlobalLocksGrid();
      }
    }

    updateAdminSummary();
    if (typeof populateResetDeptPasswordDropdown === 'function') {
      populateResetDeptPasswordDropdown();
    }
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
      sessionStorage.setItem('adminToken', result.token);
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
  if (!tabId) tabId = 'tab-admin-dashboard';
  state.currentTab = tabId;
  sessionStorage.setItem('adminActiveTab', tabId);

  // Sync sidebar active class
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  navItems.forEach(n => {
    if (n.getAttribute('data-tab') === tabId) {
      n.classList.add('active');
    } else {
      n.classList.remove('active');
    }
  });

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
    populateResetDeptPasswordDropdown();
  } else if (tabId === 'tab-admin-data') {
    const savedDataSubtab = sessionStorage.getItem('adminDataSubtab') || state.selectedDataSubtab || 'subtab-courses';
    state.selectedDataSubtab = savedDataSubtab;
    document.querySelectorAll('#tab-admin-data .tab-sub-item').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-subtab') === savedDataSubtab);
    });
    document.querySelectorAll('#tab-admin-data .subtab-pane').forEach(p => {
      p.classList.toggle('hidden', p.id !== savedDataSubtab);
    });
    renderInspectRecords();
  } else if (tabId === 'tab-admin-batch-dept') {
    renderBatchDeptMappings();
    renderBatchConfig();
    renderBatchPreview();
  } else if (tabId === 'tab-admin-group-mappings') {
    const savedAllocSubtab = sessionStorage.getItem('adminBatchAllocSubtab') || 'subtab-alloc-electives';
    document.querySelectorAll('#tab-admin-group-mappings .tab-sub-item').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-subtab') === savedAllocSubtab);
    });
    document.querySelectorAll('#tab-admin-group-mappings .subtab-pane').forEach(p => {
      p.classList.toggle('hidden', p.id !== savedAllocSubtab);
    });
    if (savedAllocSubtab === 'subtab-alloc-majors') {
      renderMajorAllocations();
    } else if (savedAllocSubtab === 'subtab-alloc-status') {
      renderBatchAllocationStatus();
    } else {
      renderGroupMappings();
    }
  } else if (tabId === 'tab-admin-common-subject-mapping') {
    renderAdminCommonSubjectMapping();
  } else if (tabId === 'tab-admin-global-locks') {
    await loadGlobalLocks();
    renderGlobalLocksGrid();
  } else if (tabId === 'tab-admin-export') {
    loadPeriodTimes();
    populateExportPreviewDropdown();
  } else if (tabId === 'tab-admin-workload') {
    renderWorkloadSummary();
  } else if (tabId === 'tab-admin-free-faculty') {
    renderFreeFacultySection();
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

  const btnBackupSqlite = document.getElementById('btn-backup-sqlite');
  if (btnBackupSqlite) {
    btnBackupSqlite.addEventListener('click', () => {
      const token = sessionStorage.getItem('adminToken');
      if (!token) return;
      window.location.href = `${API_BASE}/admin/backup/sqlite?token=${encodeURIComponent(token)}`;
    });
  }

  const btnTriggerRestoreDb = document.getElementById('btn-trigger-restore-db');
  const restoreDbFile = document.getElementById('restore-db-file');

  if (btnTriggerRestoreDb && restoreDbFile) {
    btnTriggerRestoreDb.addEventListener('click', () => {
      restoreDbFile.click();
    });

    restoreDbFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const fileName = file.name;
      const fileSizeKB = (file.size / 1024).toFixed(1);

      showModalConfirm(
        'Restore Database',
        `Are you sure you want to restore the database from "${fileName}" (${fileSizeKB} KB)?\n\nThis will overwrite current courses, faculty, allocations, and configurations with data from the backup file.`,
        async () => {
          const token = sessionStorage.getItem('adminToken');
          const formData = new FormData();
          formData.append('file', file);

          try {
            if (typeof showToast === 'function') {
              showToast('Restoring database, please wait...', 'info', 4000);
            }

            const res = await fetch(`${API_BASE}/admin/restore?token=${encodeURIComponent(token || '')}`, {
              method: 'POST',
              headers: {
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
              },
              body: formData
            });

            const data = await res.json();
            restoreDbFile.value = '';

            if (res.ok && data.success) {
              const detailsMsg = data.details
                ? ` (${data.details.courses || 0} courses, ${data.details.faculty || 0} faculty members, ${data.details.departments || 0} departments)`
                : '';
              showModalAlert('Database Restored', (data.message || 'The database has been successfully restored.') + detailsMsg, 'success', async () => {
                await fetchGlobalData();
                showTab('tab-admin-dashboard');
              });
            } else {
              showModalAlert('Restore Failed', data.message || 'Failed to restore database.', 'danger');
            }
          } catch (err) {
            console.error("Database restore error:", err);
            restoreDbFile.value = '';
            showModalAlert('Error', 'An error occurred during database restoration: ' + err.message, 'danger');
          }
        }
      );
      restoreDbFile.value = '';
    });
  }
}

// -------------------------------------------------------------
// Department Password Reset Controls (Change Password Tab)
// -------------------------------------------------------------
function populateResetDeptPasswordDropdown() {
  const select = document.getElementById('select-reset-dept-password');
  if (!select) return;

  const depts = [];
  if (Array.isArray(state.departments) && state.departments.length > 0) {
    state.departments.forEach(d => {
      if (d && d.name) depts.push(d.name.trim());
    });
  }
  if (depts.length === 0 && Array.isArray(state.courses)) {
    state.courses.forEach(c => {
      if (c && c.department) depts.push(c.department.trim());
    });
  }

  const uniqueDepts = Array.from(new Set(depts)).sort((a, b) => a.localeCompare(b));
  const currentVal = select.value;

  select.innerHTML = '<option value="">-- Choose a Department --</option>';
  uniqueDepts.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `Department of ${name}`;
    select.appendChild(opt);
  });

  if (uniqueDepts.includes(currentVal)) {
    select.value = currentVal;
  } else {
    select.value = '';
  }
  updateResetDeptDetailsView();
}

function updateResetDeptDetailsView() {
  const select = document.getElementById('select-reset-dept-password');
  const detailsCard = document.getElementById('reset-dept-details-card');
  const btnOpen = document.getElementById('btn-open-reset-dept-password');
  const nameDisplay = document.getElementById('reset-dept-name-display');
  const badge = document.getElementById('reset-dept-status-badge');

  if (!select || !btnOpen) return;
  const deptName = select.value;

  if (deptName) {
    btnOpen.disabled = false;
    if (detailsCard) detailsCard.classList.remove('hidden');
    if (nameDisplay) nameDisplay.textContent = `Department of ${deptName}`;

    if (badge) {
      const deptInfo = (state.departments || []).find(d => d.name === deptName) || { status: 'Draft' };
      badge.textContent = deptInfo.status || 'Draft';
      badge.className = 'badge';
      if (deptInfo.status === 'Approved') badge.classList.add('badge-info');
      else if (deptInfo.status === 'Submitted') badge.classList.add('recommend-p');
      else if (deptInfo.status === 'Returned for Changes') badge.classList.add('recommend-t');
      else badge.classList.add('recommend-none');
    }
  } else {
    btnOpen.disabled = true;
    if (detailsCard) detailsCard.classList.add('hidden');
  }
}

let resetDeptPwdEventsBound = false;
function bindResetDeptPasswordEvents() {
  if (resetDeptPwdEventsBound) return;
  resetDeptPwdEventsBound = true;

  const select = document.getElementById('select-reset-dept-password');
  const btnOpen = document.getElementById('btn-open-reset-dept-password');
  const modal = document.getElementById('modal-reset-dept-pwd-confirm');
  const modalDeptName = document.getElementById('reset-dept-modal-name');
  const confirmInput = document.getElementById('reset-dept-pwd-confirm-input');
  const btnConfirm = document.getElementById('btn-confirm-reset-dept-pwd');
  const btnCancel = document.getElementById('btn-cancel-reset-dept-pwd');

  if (select) {
    select.addEventListener('change', updateResetDeptDetailsView);
  }

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      const deptName = select ? select.value : '';
      if (!deptName) return;

      if (modalDeptName) modalDeptName.textContent = `Department of ${deptName}`;
      if (confirmInput) confirmInput.value = '';
      if (btnConfirm) btnConfirm.disabled = true;
      if (modal) modal.classList.remove('hidden');
      if (confirmInput) confirmInput.focus();
    });
  }

  if (confirmInput) {
    confirmInput.addEventListener('input', (e) => {
      const isMatch = e.target.value.trim().toUpperCase() === 'CONFIRM';
      if (btnConfirm) btnConfirm.disabled = !isMatch;
    });

    confirmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim().toUpperCase() === 'CONFIRM') {
        e.preventDefault();
        if (btnConfirm && !btnConfirm.disabled) {
          btnConfirm.click();
        }
      }
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (modal) modal.classList.add('hidden');
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const deptName = select ? select.value : '';
      if (!deptName) return;

      if (modal) modal.classList.add('hidden');

      try {
        const token = sessionStorage.getItem('adminToken') || '';
        const res = await fetch(`${API_BASE}/admin/departments/reset-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': token
          },
          body: JSON.stringify({ name: deptName })
        });
        const result = await res.json();
        if (res.ok) {
          showModalAlert(
            'Password Reset Successful',
            `The sign-in password for Department of ${deptName} has been reset to default: 123456`,
            'success'
          );
          await fetchGlobalData();
          populateResetDeptPasswordDropdown();
        } else {
          showModalAlert('Error', result.message || 'Failed to reset password.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Connection error while resetting department password.', 'danger');
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

  // Download format template Excel buttons
  document.querySelectorAll('.btn-download-template').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.getAttribute('data-type');
      const adminToken = sessionStorage.getItem('adminToken') || '';
      window.location.href = `${API_BASE}/admin/template/${type}?token=${encodeURIComponent(adminToken)}`;
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
// Inspect Records (Searchable Grid, Multi-Select & Class Split Management)
// -------------------------------------------------------------
let selectedCourseRecords = new Map(); // key: code:::class:::dept -> { code, class, department }

function updateBulkCoursesUI() {
  const checkboxes = document.querySelectorAll('.course-row-checkbox');
  checkboxes.forEach(cb => {
    const k = `${cb.getAttribute('data-code')}:::${cb.getAttribute('data-class')}:::${cb.getAttribute('data-dept')}`;
    cb.checked = selectedCourseRecords.has(k);
  });

  const count = selectedCourseRecords.size;
  const countLabel = document.getElementById('selected-courses-count');
  const countBadge = document.getElementById('delete-count-badge');
  const btnDelete = document.getElementById('btn-bulk-delete-courses');
  const headerCheck = document.getElementById('select-all-courses-header');

  if (countLabel) countLabel.textContent = `${count} selected`;
  if (countBadge) countBadge.textContent = String(count);
  if (btnDelete) btnDelete.disabled = (count === 0);

  if (headerCheck && window._visibleFilteredCourses && window._visibleFilteredCourses.length > 0) {
    const allVisSelected = window._visibleFilteredCourses.every(c => {
      const clNum = (c.code.match(/(_G|_C)(\d+)/) || [])[2] || (c.class || c.group || 0);
      const k = `${c.code}:::${clNum}:::${c.department}`;
      return selectedCourseRecords.has(k);
    });
    headerCheck.checked = allVisSelected;
  }
}

function bindSearchEvents() {
  const searchInput = document.getElementById('data-search-input');
  const deptFilter = document.getElementById('data-select-dept');
  const progFilter = document.getElementById('data-select-program');
  const semFilter = document.getElementById('data-select-semester');
  const catFilter = document.getElementById('data-select-category');
  
  if (searchInput) searchInput.addEventListener('input', () => renderInspectRecords());
  if (deptFilter) deptFilter.addEventListener('change', () => renderInspectRecords());
  if (progFilter) progFilter.addEventListener('change', () => renderInspectRecords());
  if (semFilter) semFilter.addEventListener('change', () => renderInspectRecords());
  if (catFilter) catFilter.addEventListener('change', () => renderInspectRecords());

  // Bulk actions buttons
  const btnSelectAll = document.getElementById('btn-bulk-select-all');
  const btnDeselectAll = document.getElementById('btn-bulk-deselect-all');
  const headerCheck = document.getElementById('select-all-courses-header');
  const btnBulkDelete = document.getElementById('btn-bulk-delete-courses');

  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      (window._visibleFilteredCourses || []).forEach(c => {
        const clNum = (c.code.match(/(_G|_C)(\d+)/) || [])[2] || (c.class || c.group || 0);
        const k = `${c.code}:::${clNum}:::${c.department}`;
        selectedCourseRecords.set(k, { code: c.code, class: parseInt(clNum, 10), department: c.department });
      });
      updateBulkCoursesUI();
    });
  }

  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', () => {
      selectedCourseRecords.clear();
      updateBulkCoursesUI();
    });
  }

  if (headerCheck) {
    headerCheck.addEventListener('change', () => {
      const isChecked = headerCheck.checked;
      if (isChecked) {
        (window._visibleFilteredCourses || []).forEach(c => {
          const clNum = (c.code.match(/(_G|_C)(\d+)/) || [])[2] || (c.class || c.group || 0);
          const k = `${c.code}:::${clNum}:::${c.department}`;
          selectedCourseRecords.set(k, { code: c.code, class: parseInt(clNum, 10), department: c.department });
        });
      } else {
        (window._visibleFilteredCourses || []).forEach(c => {
          const clNum = (c.code.match(/(_G|_C)(\d+)/) || [])[2] || (c.class || c.group || 0);
          const k = `${c.code}:::${clNum}:::${c.department}`;
          selectedCourseRecords.delete(k);
        });
      }
      updateBulkCoursesUI();
    });
  }

  if (btnBulkDelete) {
    btnBulkDelete.addEventListener('click', () => {
      const records = Array.from(selectedCourseRecords.values());
      if (records.length === 0) return;

      showModalConfirm(
        'Delete Selected Course Records?',
        `Are you sure you want to permanently delete the ${records.length} selected course record(s)? This will also remove any allocations associated with them.`,
        async () => {
          try {
            const res = await fetch(`${API_BASE}/admin/courses/bulk-delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ records })
            });
            const result = await res.json();
            if (res.ok) {
              selectedCourseRecords.clear();
              showToast(result.message || 'Courses deleted successfully.', 'success');
              await fetchGlobalData();
              renderInspectRecords();
            } else {
              showModalAlert('Error', result.message || 'Failed to delete selected courses.', 'danger');
            }
          } catch (e) {
            showModalAlert('Error', 'Connection error.', 'danger');
          }
        }
      );
    });
  }

  // Bind sub-tabs toggle for Inspect Records
  document.querySelectorAll('#tab-admin-data .tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-admin-data .tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedDataSubtab = btn.getAttribute('data-subtab');
      sessionStorage.setItem('adminDataSubtab', state.selectedDataSubtab);
      
      document.querySelectorAll('#tab-admin-data .subtab-pane').forEach(p => {
        if (p.id === state.selectedDataSubtab) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
      renderInspectRecords();
    });
  });
}

// -------------------------------------------------------------
// Batch Import & Multi-Record Creation Modal (Inspect Records)
// -------------------------------------------------------------
function initImportRecordsModal() {
  const modal = document.getElementById('modal-import-records');
  const btnOpen = document.getElementById('btn-open-import-records-modal');
  const btnClose = document.getElementById('btn-close-import-modal');
  const btnCloseX = document.getElementById('btn-close-import-modal-x');
  const btnAddRow = document.getElementById('btn-add-import-row');
  const btnClearRows = document.getElementById('btn-clear-import-rows');
  const btnSave = document.getElementById('btn-save-import-records');
  const fileInput = document.getElementById('input-import-records-file');
  const tbody = document.getElementById('import-records-tbody');
  const thead = document.getElementById('import-table-thead');
  const countBadge = document.getElementById('import-rows-count-text');
  const badgesContainer = document.getElementById('import-presets-badges');
  const titleEl = document.getElementById('import-records-modal-title');

  if (!modal || !btnOpen) return;

  const closeModal = () => modal.classList.add('hidden');
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCloseX) btnCloseX.addEventListener('click', closeModal);

  // Helper to get all known departments
  const getAllDepartments = () => {
    const deptSet = new Set();
    (state.departments || []).forEach(d => {
      const name = typeof d === 'string' ? d : d.name;
      if (name) deptSet.add(name.trim().toUpperCase());
    });
    (state.courses || []).forEach(c => c.department && deptSet.add(c.department.trim().toUpperCase()));
    (state.faculty || []).forEach(f => f.department && deptSet.add(f.department.trim().toUpperCase()));
    return Array.from(deptSet).sort();
  };

  // Helper to get all known categories
  const getAllCategories = () => {
    const catSet = new Set(['MAJOR', 'MINOR', 'IDC', 'AEC', 'SEC', 'VAC', 'MDC']);
    (state.courses || []).forEach(c => c.category && catSet.add(c.category.trim().toUpperCase()));
    return Array.from(catSet).sort();
  };

  const updateRowCount = () => {
    const rows = tbody.querySelectorAll('tr');
    if (countBadge) {
      countBadge.textContent = `${rows.length} ${rows.length === 1 ? 'record' : 'records'} ready`;
    }
    // Re-index row numbers
    rows.forEach((tr, idx) => {
      const numCell = tr.querySelector('.row-idx');
      if (numCell) numCell.textContent = String(idx + 1);
    });
  };

  // Add a Course row (auto-filling from active filters)
  const addCourseRow = (initial = {}) => {
    const depts = getAllDepartments();
    const cats = getAllCategories();
    const activeDept = document.getElementById('data-select-dept')?.value || '';
    const activeProg = document.getElementById('data-select-program')?.value || '';
    const activeSem = document.getElementById('data-select-semester')?.value || '';
    const activeCat = document.getElementById('data-select-category')?.value || '';

    const curDept = initial.department || activeDept;
    const curProg = (initial.programType || initial.program || activeProg || '').toUpperCase();
    const curSem = initial.semester || activeSem || '1';
    const curCat = initial.category || activeCat || 'MAJOR';
    const curCode = initial.code || '';
    const curName = initial.name || '';
    const curAlias = initial.alias || '';
    const curClasses = parseInt(initial.classes || 1, 10) || 1;

    const tr = document.createElement('tr');
    tr.className = 'import-row-course';
    tr.innerHTML = `
      <td class="row-idx" style="text-align: center; vertical-align: middle; font-weight: 700; color: var(--text-muted); font-size: 12px;"></td>
      <td>
        <input type="text" class="form-control form-control-sm inp-course-code" placeholder="e.g. CS101" value="${escapeHtml(curCode)}" style="text-transform: uppercase; font-weight: 700; padding: 4px 8px; font-size: 12.5px; height: 32px;" required>
      </td>
      <td>
        <input type="text" class="form-control form-control-sm inp-course-name" placeholder="e.g. Data Structures" value="${escapeHtml(curName)}" style="padding: 4px 8px; font-size: 12.5px; height: 32px;" required>
      </td>
      <td>
        <select class="form-control form-control-sm inp-course-program" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          <option value="" disabled ${!curProg ? 'selected' : ''}>Select Program</option>
          <option value="UG" ${curProg === 'UG' ? 'selected' : ''}>UG</option>
          <option value="PG" ${curProg === 'PG' ? 'selected' : ''}>PG</option>
          <option value="INT" ${curProg === 'INT' ? 'selected' : ''}>INT</option>
        </select>
      </td>
      <td>
        <select class="form-control form-control-sm inp-course-sem" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          ${[1, 2, 3, 4, 5, 6, 7, 8].map(s => `<option value="${s}" ${String(s) === String(curSem) ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="form-control form-control-sm inp-course-cat" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          ${cats.map(c => `<option value="${c}" ${c.toUpperCase() === String(curCat).toUpperCase() ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="form-control form-control-sm inp-course-dept" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          <option value="" disabled ${!curDept ? 'selected' : ''}>Select Dept</option>
          ${depts.map(d => `<option value="${d}" ${d.toUpperCase() === String(curDept).toUpperCase() ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </td>
      <td>
        <input type="text" class="form-control form-control-sm inp-course-alias" placeholder="Optional" value="${escapeHtml(curAlias)}" style="padding: 4px 8px; font-size: 12.5px; height: 32px;">
      </td>
      <td>
        <select class="form-control form-control-sm inp-course-classes" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          <option value="1" ${curClasses === 1 ? 'selected' : ''}>1</option>
          <option value="2" ${curClasses === 2 ? 'selected' : ''}>2</option>
          <option value="3" ${curClasses === 3 ? 'selected' : ''}>3</option>
          <option value="4" ${curClasses === 4 ? 'selected' : ''}>4</option>
          <option value="5" ${curClasses === 5 ? 'selected' : ''}>5</option>
        </select>
      </td>
      <td style="text-align: center; vertical-align: middle;">
        <button type="button" class="btn btn-outline btn-xs btn-remove-row text-danger" title="Remove Row" style="border: none; padding: 4px 6px;">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;

    tr.querySelector('.btn-remove-row').addEventListener('click', () => {
      tr.remove();
      updateRowCount();
    });

    tbody.appendChild(tr);
    updateRowCount();

    const container = tbody.closest('.table-responsive');
    if (container) container.scrollTop = container.scrollHeight;
  };

  // Add a Faculty row (auto-filling from active department filter)
  const addFacultyRow = (initial = {}) => {
    const depts = getAllDepartments();
    const activeDept = document.getElementById('data-select-dept')?.value || '';
    const curDept = initial.department || activeDept;
    const curStaffId = initial.staffId || '';
    const curName = initial.name || '';
    const curCode = initial.code || '';

    const tr = document.createElement('tr');
    tr.className = 'import-row-faculty';
    tr.innerHTML = `
      <td class="row-idx" style="text-align: center; vertical-align: middle; font-weight: 700; color: var(--text-muted); font-size: 12px;"></td>
      <td>
        <input type="text" class="form-control form-control-sm inp-faculty-staffid" placeholder="e.g. CS012" value="${escapeHtml(curStaffId)}" style="text-transform: uppercase; font-weight: 700; padding: 4px 8px; font-size: 12.5px; height: 32px;" required>
      </td>
      <td>
        <input type="text" class="form-control form-control-sm inp-faculty-name" placeholder="e.g. Dr. John Doe" value="${escapeHtml(curName)}" style="padding: 4px 8px; font-size: 12.5px; height: 32px;" required>
      </td>
      <td>
        <input type="text" class="form-control form-control-sm inp-faculty-code" placeholder="Auto" value="${escapeHtml(curCode)}" style="text-transform: uppercase; padding: 4px 8px; font-size: 12.5px; height: 32px;">
      </td>
      <td>
        <select class="form-control form-control-sm inp-faculty-dept" style="padding: 4px 6px; font-size: 12.5px; height: 32px;">
          <option value="" disabled ${!curDept ? 'selected' : ''}>Select Dept</option>
          ${depts.map(d => `<option value="${d}" ${d.toUpperCase() === String(curDept).toUpperCase() ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </td>
      <td style="text-align: center; vertical-align: middle;">
        <button type="button" class="btn btn-outline btn-xs btn-remove-row text-danger" title="Remove Row" style="border: none; padding: 4px 6px;">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;

    tr.querySelector('.btn-remove-row').addEventListener('click', () => {
      tr.remove();
      updateRowCount();
    });

    tbody.appendChild(tr);
    updateRowCount();

    const container = tbody.closest('.table-responsive');
    if (container) container.scrollTop = container.scrollHeight;
  };

  // Open modal trigger
  btnOpen.addEventListener('click', () => {
    const isCourses = (!state.selectedDataSubtab || state.selectedDataSubtab === 'subtab-courses');
    const activeDept = document.getElementById('data-select-dept')?.value || '';
    const activeProg = document.getElementById('data-select-program')?.value || '';
    const activeSem = document.getElementById('data-select-semester')?.value || '';
    const activeCat = document.getElementById('data-select-category')?.value || '';

    // Title
    if (titleEl) {
      titleEl.innerHTML = isCourses
        ? '<i class="fa-solid fa-book-open text-primary"></i> Import & Add Courses'
        : '<i class="fa-solid fa-user-plus text-primary"></i> Import & Add Faculty';
    }

    // Presets Badges
    if (badgesContainer) {
      badgesContainer.innerHTML = '';
      let hasFilter = false;
      if (activeDept) {
        hasFilter = true;
        badgesContainer.innerHTML += `<span class="badge badge-info" style="font-size: 11.5px; padding: 3px 8px;"><i class="fa-solid fa-building"></i> Dept: ${escapeHtml(activeDept)}</span>`;
      }
      if (isCourses && activeProg) {
        hasFilter = true;
        badgesContainer.innerHTML += `<span class="badge badge-info" style="font-size: 11.5px; padding: 3px 8px;"><i class="fa-solid fa-graduation-cap"></i> Program: ${escapeHtml(activeProg)}</span>`;
      }
      if (isCourses && activeSem) {
        hasFilter = true;
        badgesContainer.innerHTML += `<span class="badge badge-info" style="font-size: 11.5px; padding: 3px 8px;"><i class="fa-solid fa-calendar-days"></i> Sem: ${escapeHtml(activeSem)}</span>`;
      }
      if (isCourses && activeCat) {
        hasFilter = true;
        badgesContainer.innerHTML += `<span class="badge badge-info" style="font-size: 11.5px; padding: 3px 8px;"><i class="fa-solid fa-tag"></i> Category: ${escapeHtml(activeCat)}</span>`;
      }
      if (!hasFilter) {
        badgesContainer.innerHTML = `<span class="text-muted" style="font-size: 12px; font-weight: normal;">None (All columns open for manual selection)</span>`;
      }
    }

    // Thead
    if (thead) {
      thead.innerHTML = isCourses ? `
        <tr>
          <th style="width: 44px; text-align: center;">#</th>
          <th style="min-width: 130px;">Course Code *</th>
          <th style="min-width: 220px;">Course Name *</th>
          <th style="width: 105px;">Program *</th>
          <th style="width: 95px;">Semester *</th>
          <th style="width: 125px;">Category *</th>
          <th style="min-width: 180px;">Department *</th>
          <th style="width: 110px;">Visual Alias</th>
          <th style="width: 80px;">Classes</th>
          <th style="width: 45px; text-align: center;"></th>
        </tr>
      ` : `
        <tr>
          <th style="width: 44px; text-align: center;">#</th>
          <th style="min-width: 150px;">Staff ID *</th>
          <th style="min-width: 260px;">Faculty Name *</th>
          <th style="width: 130px;">Initials Code</th>
          <th style="min-width: 240px;">Department *</th>
          <th style="width: 50px; text-align: center;"></th>
        </tr>
      `;
    }

    // Reset rows and add 1 initial row
    tbody.innerHTML = '';
    if (isCourses) {
      addCourseRow();
    } else {
      addFacultyRow();
    }

    modal.classList.remove('hidden');
  });

  // Add row button
  if (btnAddRow) {
    btnAddRow.addEventListener('click', () => {
      const isCourses = (!state.selectedDataSubtab || state.selectedDataSubtab === 'subtab-courses');
      if (isCourses) {
        addCourseRow();
      } else {
        addFacultyRow();
      }
    });
  }

  // Clear rows button
  if (btnClearRows) {
    btnClearRows.addEventListener('click', () => {
      tbody.innerHTML = '';
      updateRowCount();
    });
  }

  // File upload trigger
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const isCourses = (!state.selectedDataSubtab || state.selectedDataSubtab === 'subtab-courses');
      const activeDept = document.getElementById('data-select-dept')?.value || '';
      const activeProg = document.getElementById('data-select-program')?.value || '';
      const activeSem = document.getElementById('data-select-semester')?.value || '';
      const activeCat = document.getElementById('data-select-category')?.value || '';

      try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(firstSheet);

        if (!Array.isArray(json) || json.length === 0) {
          showToast('No rows found in uploaded spreadsheet.', 'warning');
          fileInput.value = '';
          return;
        }

        let loadedCount = 0;
        json.forEach(row => {
          if (isCourses) {
            const code = row['Course Code'] || row['CourseCode'] || row['Code'] || row['code'] || '';
            const name = row['Course Name'] || row['CourseName'] || row['Name'] || row['name'] || row['Title'] || '';
            const prog = row['Program'] || row['ProgramType'] || row['program'] || row['programType'] || row['Prog'] || activeProg || 'UG';
            const sem = row['Semester'] || row['Sem'] || row['semester'] || activeSem || '1';
            const cat = row['Category'] || row['Cat'] || row['category'] || activeCat || 'MAJOR';
            const dept = row['Department'] || row['Dept'] || row['department'] || activeDept || '';
            const alias = row['Visual Alias'] || row['Alias'] || row['alias'] || '';
            const classes = row['Classes'] || row['classes'] || row['Class'] || 1;

            if (code || name) {
              addCourseRow({ code, name, programType: prog, semester: sem, category: cat, department: dept, alias, classes });
              loadedCount++;
            }
          } else {
            const staffId = row['Staff ID'] || row['StaffId'] || row['StaffID'] || row['staffId'] || '';
            const name = row['Name'] || row['Faculty Name'] || row['FacultyName'] || row['name'] || '';
            const code = row['Code'] || row['Initials'] || row['Initials Code'] || row['code'] || '';
            const dept = row['Department'] || row['Dept'] || row['department'] || activeDept || '';

            if (staffId || name) {
              addFacultyRow({ staffId, name, code, department: dept });
              loadedCount++;
            }
          }
        });

        fileInput.value = '';
        showToast(`Loaded ${loadedCount} record(s) from spreadsheet with active filter presets.`, 'success');
      } catch (err) {
        console.error("Spreadsheet import error:", err);
        fileInput.value = '';
        showToast('Error reading spreadsheet: ' + err.message, 'danger');
      }
    });
  }

  // Save records button
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const isCourses = (!state.selectedDataSubtab || state.selectedDataSubtab === 'subtab-courses');
      const rows = tbody.querySelectorAll('tr');

      if (rows.length === 0) {
        showToast('Please add at least one record before saving.', 'warning');
        return;
      }

      const token = sessionStorage.getItem('adminToken');

      if (isCourses) {
        const payloadCourses = [];
        let hasValidationError = false;

        rows.forEach(tr => {
          const code = (tr.querySelector('.inp-course-code')?.value || '').trim();
          const name = (tr.querySelector('.inp-course-name')?.value || '').trim();
          const programType = (tr.querySelector('.inp-course-program')?.value || '').trim();
          const semester = (tr.querySelector('.inp-course-sem')?.value || '').trim();
          const category = (tr.querySelector('.inp-course-cat')?.value || '').trim();
          const department = (tr.querySelector('.inp-course-dept')?.value || '').trim();
          const alias = (tr.querySelector('.inp-course-alias')?.value || '').trim();
          const classes = parseInt(tr.querySelector('.inp-course-classes')?.value || 1, 10) || 1;

          if (!code || !name || !department || !programType) {
            hasValidationError = true;
            tr.style.background = '#fef2f2';
          } else {
            tr.style.background = '';
            payloadCourses.push({
              code,
              name,
              programType,
              semester,
              category,
              department,
              alias,
              classes
            });
          }
        });

        if (hasValidationError) {
          showToast('Please fill all required fields (Course Code, Name, Program, Department) in highlighted rows.', 'warning');
          return;
        }

        try {
          btnSave.disabled = true;
          btnSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

          const res = await fetch(`${API_BASE}/admin/courses/batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ courses: payloadCourses })
          });

          const result = await res.json();
          btnSave.disabled = false;
          btnSave.innerHTML = '<i class="fa-solid fa-check"></i> Save Records';

          if (res.ok && result.success) {
            closeModal();
            showToast(result.message || `Successfully saved ${payloadCourses.length} course(s).`, 'success');
            await fetchGlobalData();
            renderInspectRecords();
          } else {
            showToast(result.message || 'Failed to save courses.', 'danger');
          }
        } catch (err) {
          btnSave.disabled = false;
          btnSave.innerHTML = '<i class="fa-solid fa-check"></i> Save Records';
          console.error("Save error:", err);
          showToast('Connection error: ' + err.message, 'danger');
        }
      } else {
        // Faculty save
        const payloadFaculty = [];
        let hasValidationError = false;

        rows.forEach(tr => {
          const staffId = (tr.querySelector('.inp-faculty-staffid')?.value || '').trim();
          const name = (tr.querySelector('.inp-faculty-name')?.value || '').trim();
          const code = (tr.querySelector('.inp-faculty-code')?.value || '').trim();
          const department = (tr.querySelector('.inp-faculty-dept')?.value || '').trim();

          if (!staffId || !name || !department) {
            hasValidationError = true;
            tr.style.background = '#fef2f2';
          } else {
            tr.style.background = '';
            payloadFaculty.push({
              staffId,
              name,
              code,
              department
            });
          }
        });

        if (hasValidationError) {
          showToast('Please fill all required fields (Staff ID, Name, Department) in highlighted rows.', 'warning');
          return;
        }

        try {
          btnSave.disabled = true;
          btnSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

          const res = await fetch(`${API_BASE}/admin/faculty/batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ faculty: payloadFaculty })
          });

          const result = await res.json();
          btnSave.disabled = false;
          btnSave.innerHTML = '<i class="fa-solid fa-check"></i> Save Records';

          if (res.ok && result.success) {
            closeModal();
            showToast(result.message || `Successfully saved ${payloadFaculty.length} faculty member(s).`, 'success');
            await fetchGlobalData();
            renderInspectRecords();
          } else {
            showToast(result.message || 'Failed to save faculty.', 'danger');
          }
        } catch (err) {
          btnSave.disabled = false;
          btnSave.innerHTML = '<i class="fa-solid fa-check"></i> Save Records';
          console.error("Save error:", err);
          showToast('Connection error: ' + err.message, 'danger');
        }
      }
    });
  }
}

function renderInspectRecords() {
  const query = document.getElementById('data-search-input').value.toLowerCase().trim();
  const selectedDept = document.getElementById('data-select-dept').value;
  const progFilter = document.getElementById('data-select-program');
  const semFilter = document.getElementById('data-select-semester');
  const catFilter = document.getElementById('data-select-category');
  const selectedProgram = progFilter ? progFilter.value : '';
  const selectedSemester = semFilter ? semFilter.value : '';
  const selectedCategory = catFilter ? catFilter.value : '';

  const isCourses = (!state.selectedDataSubtab || state.selectedDataSubtab === 'subtab-courses');
  if (progFilter) progFilter.style.display = isCourses ? '' : 'none';
  if (semFilter) semFilter.style.display = isCourses ? '' : 'none';
  if (catFilter) catFilter.style.display = isCourses ? '' : 'none';

  // Initialize department filter dropdown options
  const deptFilter = document.getElementById('data-select-dept');
  if (deptFilter && deptFilter.options.length <= 1) {
    const deptSet = new Set();
    state.courses.forEach(c => c.department && deptSet.add(c.department));
    state.faculty.forEach(f => f.department && deptSet.add(f.department));
    Array.from(deptSet).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      deptFilter.appendChild(opt);
    });
  }

  // Initialize semester filter dropdown options
  if (semFilter && semFilter.options.length <= 1) {
    const semSet = new Set();
    state.courses.forEach(c => {
      if (c.semester !== undefined && c.semester !== null && c.semester !== '') {
        semSet.add(String(c.semester));
      }
    });
    Array.from(semSet).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)).forEach(sem => {
      const opt = document.createElement('option');
      opt.value = sem;
      opt.textContent = `Semester ${sem}`;
      semFilter.appendChild(opt);
    });
  }

  // Initialize category filter dropdown options
  if (catFilter && catFilter.options.length <= 1) {
    const catSet = new Set();
    state.courses.forEach(c => {
      if (c.category) catSet.add(String(c.category).trim());
    });
    Array.from(catSet).sort().forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      catFilter.appendChild(opt);
    });
  }

  // Filter Courses
  let filteredCourses = state.courses;
  if (selectedDept) {
    filteredCourses = filteredCourses.filter(c => c.department === selectedDept);
  }
  if (selectedProgram) {
    filteredCourses = filteredCourses.filter(c => String(c.programType || 'UG').trim().toUpperCase() === selectedProgram.trim().toUpperCase());
  }
  if (selectedSemester) {
    filteredCourses = filteredCourses.filter(c => String(c.semester) === String(selectedSemester));
  }
  if (selectedCategory) {
    filteredCourses = filteredCourses.filter(c => String(c.category || '').trim().toUpperCase() === String(selectedCategory).trim().toUpperCase());
  }
  if (query) {
    filteredCourses = filteredCourses.filter(c => 
      c.code.toLowerCase().includes(query) || 
      c.name.toLowerCase().includes(query) || 
      (c.alias && c.alias.toLowerCase().includes(query))
    );
  }

  // Sort courses so that class variants of the same course and department are contiguous for table grouping
  filteredCourses = [...filteredCourses].sort((a, b) => {
    const cleanA = a.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const cleanB = b.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    if (cleanA !== cleanB) return cleanA.localeCompare(cleanB);
    const deptA = (a.department || '').toUpperCase();
    const deptB = (b.department || '').toUpperCase();
    if (deptA !== deptB) return deptA.localeCompare(deptB);
    const classA = a.class || (a.code.match(/(_G|_C)(\d+)/) ? parseInt(a.code.match(/(_G|_C)(\d+)/)[2], 10) : 0);
    const classB = b.class || (b.code.match(/(_G|_C)(\d+)/) ? parseInt(b.code.match(/(_G|_C)(\d+)/)[2], 10) : 0);
    return classA - classB;
  });

  window._visibleFilteredCourses = filteredCourses;
  document.getElementById('count-courses').textContent = filteredCourses.length;

  // Group counts for action buttons per (cleanBaseCode + department)
  const groupCounts = {};
  filteredCourses.forEach(c => {
    const clean = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const gk = `${clean}:::${(c.department || '').toUpperCase()}`;
    groupCounts[gk] = (groupCounts[gk] || 0) + 1;
  });

  const seenGroups = new Set();
  const coursesTbody = document.querySelector('#table-manage-courses tbody');
  coursesTbody.innerHTML = '';

  filteredCourses.forEach(c => {
    const tr = document.createElement('tr');
    const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
    const classNum = classNumMatch ? parseInt(classNumMatch[2], 10) : (c.class || c.group || 0);
    const cleanCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const codeDisplay = classNum
      ? `${cleanCode} <span class="badge" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px;">C${classNum}</span>`
      : cleanCode;
    
    const rowKey = `${c.code}:::${classNum}:::${c.department}`;
    const isChecked = selectedCourseRecords.has(rowKey);

    const gk = `${cleanCode}:::${(c.department || '').toUpperCase()}`;
    const isFirstInGroup = !seenGroups.has(gk);
    if (isFirstInGroup) seenGroups.add(gk);

    let actionsTdHtml = '';
    if (isFirstInGroup) {
      const spanCount = groupCounts[gk] || 1;
      actionsTdHtml = `
        <td rowspan="${spanCount}" class="actions-cell" style="vertical-align: middle; text-align: center; border-left: 1px solid var(--border); background: var(--surface);">
          <div style="display: inline-flex; gap: 4px; align-items: center; justify-content: center;">
            <button type="button" class="btn btn-outline btn-sm btn-edit-course" style="padding: 3px 8px; font-weight: 600;" title="Edit Course details & class split for ${c.department}">
              <i class="fa-solid fa-edit text-primary"></i> Edit
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-danger btn-delete-course" style="padding: 3px 8px; font-weight: 600;" title="Delete all classes of this course in ${c.department}">
              <i class="fa-solid fa-trash"></i> Delete
            </button>
          </div>
        </td>
      `;
    }

    const progColor = (c.programType === 'PG') ? '#0284c7' : (c.programType === 'INT' ? '#7c3aed' : '#059669');
    const progBadge = `<span class="badge" style="background-color: ${progColor}; color: white; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 4px;">${escapeHtml(c.programType || 'UG')}</span>`;

    tr.innerHTML = `
      <td style="text-align: center; width: 44px;">
        <input type="checkbox" class="course-row-checkbox" data-code="${c.code}" data-class="${classNum}" data-dept="${c.department}" ${isChecked ? 'checked' : ''}>
      </td>
      <td><strong>${codeDisplay}</strong></td>
      <td>${progBadge}</td>
      <td>${c.semester}</td>
      <td>${c.category}</td>
      <td>${c.name}</td>
      <td><span class="badge badge-info">${c.alias || '-'}</span></td>
      <td><span class="text-sm text-muted font-semibold">${c.department}</span></td>
      ${actionsTdHtml}
    `;

    // Row checkbox listener
    const rowCb = tr.querySelector('.course-row-checkbox');
    rowCb.addEventListener('change', () => {
      if (rowCb.checked) {
        selectedCourseRecords.set(rowKey, { code: c.code, class: classNum, department: c.department });
      } else {
        selectedCourseRecords.delete(rowKey);
      }
      updateBulkCoursesUI();
    });

    if (isFirstInGroup) {
      const btnEdit = tr.querySelector('.btn-edit-course');
      const btnDelete = tr.querySelector('.btn-delete-course');

      btnEdit.addEventListener('click', () => {
        document.getElementById('edit-course-code').value = cleanCode;
        document.getElementById('edit-course-dept').value = c.department;
        document.getElementById('edit-course-name').value = c.name;
        document.getElementById('edit-course-program').value = (c.programType || 'UG').toUpperCase();
        document.getElementById('edit-course-alias').value = c.alias || '';
        
        // Count how many class variants exist for this cleanCode and department
        const deptVariants = state.courses.filter(x => 
          x.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === cleanCode && 
          (x.department || '').toUpperCase() === (c.department || '').toUpperCase()
        );
        const currentCount = deptVariants.length > 0 ? deptVariants.length : (c.classes || 1);
        const classSelect = document.getElementById('edit-course-classes');
        if (classSelect) {
          classSelect.value = String(Math.max(1, Math.min(5, currentCount)));
        }

        const titleEl = document.getElementById('edit-course-modal-title');
        if (titleEl) {
          titleEl.textContent = `Edit Course: ${cleanCode} (${c.department})`;
        }

        document.getElementById('modal-edit-course').classList.remove('hidden');
      });

      btnDelete.addEventListener('click', () => {
        showModalConfirm(
          'Delete Course?',
          `Are you sure you want to delete course '${c.name}' (${cleanCode}) in department '${c.department}'? This will remove all ${groupCounts[gk]} class record(s) and their allocations.`,
          async () => {
            try {
              const res = await fetch(`${API_BASE}/admin/courses/${encodeURIComponent(cleanCode)}?department=${encodeURIComponent(c.department)}`, {
                method: 'DELETE'
              });
              const result = await res.json();
              if (res.ok) {
                // Clear any selected records for this course & dept
                Array.from(selectedCourseRecords.keys()).forEach(k => {
                  if (k.startsWith(`${cleanCode}`) && k.endsWith(`:::${c.department}`)) {
                    selectedCourseRecords.delete(k);
                  }
                });
                showToast('Course deleted successfully.', 'success');
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
    }

    coursesTbody.appendChild(tr);
  });

  updateBulkCoursesUI();

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
              showToast('Faculty member deleted successfully.', 'success');
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
  
  document.getElementById('btn-trigger-print').addEventListener('click', async () => {
    await buildPrintTimetableHtml(document.getElementById('print-mode-select')?.value || 'medium');
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
  const periods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
  const table = document.getElementById('print-grid-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  thead.innerHTML = `
    <tr>
      <th style="width: 80px;">Day</th>
      <th style="width: 100px; text-align: left;">Class/Semester</th>
      ${periods.map(p => `<th>${String(p).toUpperCase() === 'LB' ? 'Lunch Break' : p}</th>`).join('')}
    </tr>
  `;

  try {
    const res = await fetch(`${API_BASE}/allocations?department=${encodeURIComponent(activePrintDept)}`);
    const allocs = await res.json();
    const deptUpper = (activePrintDept || '').trim().toUpperCase();
    const deptCourses = (state.courses || []).filter(c => {
      const cDept = (c.department || '').trim().toUpperCase();
      if (cDept === deptUpper) return true;
      const cBase = (c.code || '').replace(/-(T|P)$/, '');
      return allocs[c.code] || allocs[cBase] || allocs[`${cBase}-T`] || allocs[`${cBase}-P`];
    });
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
  const semLabel = (state.config && state.config.semesterLabels && state.config.semesterLabels[course.semester]) || `${course.semester} Sem`;
  const catStr = formatCategory(course.category);
  
  if (semLabel.toUpperCase().includes('BSC') || semLabel.toUpperCase().includes('MSC')) {
    return `${semLabel} ${catStr}`;
  }
  
  const isPg = course.code.toUpperCase().includes('MSC') || 
               (course.pathway && course.pathway.toUpperCase().includes('MSC')) || 
               (course.pathway && course.pathway.toUpperCase().includes('POST GRADUATE')) ||
               course.programType === 'PG';
  const progLabel = isPg ? 'MSC' : 'BSC';
  return `${semLabel} ${progLabel} ${catStr}`;
}

// Universal Slot Type Resolver: determines if an assigned or recommended slot is Theory ('T'), Practical ('P'), or MDC ('M')
function determineSlotType(course, cCode, day, period, facList = [], dayAllocations = {}, deptMapping = null) {
  const codeStr = String(cCode || (course && course.code) || '').trim();
  
  // 1. Explicit suffix in course key always takes precedence
  if (codeStr.endsWith('-P') || codeStr.includes('-P_') || codeStr.includes('_P-') || codeStr.includes('-P(')) return 'P';
  if (codeStr.endsWith('-T') || codeStr.includes('-T_') || codeStr.includes('_T-') || codeStr.includes('-T(')) return 'T';
  
  // 2. Multidisciplinary / Minor category check
  if ((course && course.courseType === 'M') || (course && course.category === 'MDC')) return 'M';

  // 3. Curriculum Recommendation check (if set for this slot in course)
  if (course && course.recommendations && course.recommendations[day]) {
    const rec = course.recommendations[day][period];
    if (rec === 'P') return 'P';
    if (rec === 'T') return 'T';
    if (rec === 'B') return 'B';
  }

  // 4. Pure course types: pure Theory (practicalHours === 0) or pure Practical (theoryHours === 0)
  const thHours = (course && typeof course.theoryHours === 'number') ? course.theoryHours : null;
  const prHours = (course && typeof course.practicalHours === 'number') ? course.practicalHours : null;

  if (thHours !== null && prHours !== null) {
    if (prHours === 0 && thHours > 0) return 'T';
    if (thHours === 0 && prHours > 0) return 'P';
  } else if (course && course.courseType === 'T') {
    return 'T';
  }

  // 5. Composite / Hybrid courses (courses with both Theory and Practical hours)
  const assignedList = Array.isArray(facList) ? facList.filter(Boolean) : [];

  // 5a. If multiple co-teachers assigned together in the slot (e.g. 2+ faculty) -> Practical lab session
  if (assignedList.length > 1) {
    return 'P';
  }

  // 5b. Check consecutive periods with the same faculty on the same day (labs are 2+ periods)
  if (dayAllocations && typeof dayAllocations === 'object') {
    const pNum = parseInt(String(period).replace(/\D+/g, ''), 10);
    if (!isNaN(pNum)) {
      const prevPeriod = String(pNum - 1);
      const nextPeriod = String(pNum + 1);
      const prevList = Array.isArray(dayAllocations[prevPeriod]) ? dayAllocations[prevPeriod] : [];
      const nextList = Array.isArray(dayAllocations[nextPeriod]) ? dayAllocations[nextPeriod] : [];
      
      const sharesFacultyPrev = assignedList.length > 0 && assignedList.some(f => prevList.includes(f));
      const sharesFacultyNext = assignedList.length > 0 && assignedList.some(f => nextList.includes(f));
      
      if (sharesFacultyPrev || sharesFacultyNext) {
        return 'P';
      }
    }
  }

  // 5c. Check Subject-Teacher Mapping if available
  const baseCode = codeStr.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
  const courseMap = deptMapping || 
    (typeof state !== 'undefined' && state.subjectTeacherMapping && (
      (course && course.department && state.subjectTeacherMapping[course.department.toUpperCase()] && state.subjectTeacherMapping[course.department.toUpperCase()][baseCode]) ||
      (typeof activePrintDept !== 'undefined' && activePrintDept && state.subjectTeacherMapping[activePrintDept.toUpperCase()] && state.subjectTeacherMapping[activePrintDept.toUpperCase()][baseCode]) ||
      (typeof adminActiveTeacherDept !== 'undefined' && adminActiveTeacherDept && state.subjectTeacherMapping[adminActiveTeacherDept.toUpperCase()] && state.subjectTeacherMapping[adminActiveTeacherDept.toUpperCase()][baseCode])
    ));

  if (courseMap && assignedList.length > 0) {
    const isOnlyPractical = assignedList.every(f => 
      (courseMap.practicalTeachers || []).includes(f) && !(courseMap.theoryTeachers || []).includes(f)
    );
    if (isOnlyPractical) return 'P';

    const isOnlyTheory = assignedList.every(f => 
      (courseMap.theoryTeachers || []).includes(f) && !(courseMap.practicalTeachers || []).includes(f)
    );
    if (isOnlyTheory) return 'T';
  }

  // 5d. Standalone single-period slot with 1 teacher for a hybrid course
  // In college schedules, 1-period isolated sessions are Theory lectures
  if (thHours && thHours > 0) {
    return 'T';
  }

  return (course && course.courseType === 'P') ? 'P' : 'T';
}
window.determineSlotType = determineSlotType;

// Probes all possible allocation keys (exact, -T, -P, baseCode, class variants _C1-T, _C1-P)
function getCourseSlotAllocations(course, day, period, allocations) {
  if (!allocations || !course) return { codes: [], type: (course && course.courseType) || 'T' };
  
  const cCode = course.code || '';
  const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
  const classMatch = cCode.match(/(_C|_G)(\d+)/);
  const classNum = course.classNum || (classMatch ? classMatch[2] : ((course.class && course.class > 0) ? course.class : null));

  const foundCodes = [];
  let detectedType = course.courseType || (cCode.endsWith('-P') ? 'P' : 'T');

  const keysToCheck = [];
  if (classNum) {
    keysToCheck.push({ key: `${baseCode}_C${classNum}-T`, type: 'T' });
    keysToCheck.push({ key: `${baseCode}_C${classNum}-P`, type: 'P' });
    keysToCheck.push({ key: `${baseCode}_C${classNum}`, type: detectedType });
    keysToCheck.push({ key: `${baseCode}_G${classNum}-T`, type: 'T' });
    keysToCheck.push({ key: `${baseCode}_G${classNum}-P`, type: 'P' });
    keysToCheck.push({ key: `${baseCode}_G${classNum}`, type: detectedType });
  }
  keysToCheck.push({ key: cCode, type: cCode.endsWith('-P') ? 'P' : (cCode.endsWith('-T') ? 'T' : detectedType) });
  keysToCheck.push({ key: `${cCode}-T`, type: 'T' });
  keysToCheck.push({ key: `${cCode}-P`, type: 'P' });
  keysToCheck.push({ key: `${baseCode}-T`, type: 'T' });
  keysToCheck.push({ key: `${baseCode}-P`, type: 'P' });
  keysToCheck.push({ key: baseCode, type: detectedType });

  const seenKeys = new Set();
  keysToCheck.forEach(({ key, type }) => {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    if (allocations[key] && allocations[key][day] && allocations[key][day][period]) {
      const list = allocations[key][day][period];
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(fc => {
          const cleanFc = (fc || '').trim();
          if (cleanFc && !foundCodes.includes(cleanFc)) {
            foundCodes.push(cleanFc);
          }
        });
      }
    }
  });

  if (foundCodes.length > 0) {
    const dayAllocations = {};
    const periodsList = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
    periodsList.forEach(p => {
      keysToCheck.forEach(({ key }) => {
        if (allocations[key] && allocations[key][day] && allocations[key][day][p]) {
          const l = allocations[key][day][p];
          if (Array.isArray(l) && l.length > 0) {
            dayAllocations[p] = Array.from(new Set([...(dayAllocations[p] || []), ...l]));
          }
        }
      });
    });
    detectedType = determineSlotType(course, cCode, day, period, foundCodes, dayAllocations);
  }

  return { codes: foundCodes, type: detectedType };
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
        const slotDataMap = {};

        periods.forEach(p => {
          if (String(p).toUpperCase() === 'LB') return;
          const { codes: assigned, type: detectedType } = getCourseSlotAllocations(course, day, p, allocations);
          if (assigned.length > 0) {
            coursePeriods.push(p);
            const isPractical = detectedType === 'P';
            const printClass = detectedType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
            const tooltip = assigned.map(code => {
              const facObj = (state.faculty || []).find(f => f.code === code);
              return facObj ? facObj.name : code;
            }).join(' / ');

            slotDataMap[p] = {
              html: formatAllocationCell(course, day, p, allocations, displayMode, detectedType),
              classes: printClass,
              tooltip: tooltip
            };
          }
        });

        if (coursePeriods.length === 0) return;

        let placed = false;
        for (let r = 0; r < subRows.length; r++) {
          const hasClash = coursePeriods.some(p => !!subRows[r][p]);
          if (!hasClash) {
            coursePeriods.forEach(p => {
              subRows[r][p] = slotDataMap[p];
            });
            placed = true;
            break;
          }
        }

        if (!placed) {
          const newRow = {};
          coursePeriods.forEach(p => {
            newRow[p] = slotDataMap[p];
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
          tdDay.textContent = weekdayShort[day] || day;
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
          if (String(p).toUpperCase() === 'LB') {
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

function formatAllocationCell(course, day, period, allocations, mode, detectedType = null) {
  const { codes: assignedCodes, type: allocType } = getCourseSlotAllocations(course, day, period, allocations);
  if (assignedCodes.length === 0) return '';

  const alias = (course.alias || course.name || course.code).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNum = course.classNum || (course.code.match(/(_G|_C)(\d+)/) ? course.code.match(/(_G|_C)(\d+)/)[2] : ((course.class && course.class > 0) ? course.class : ((course.group && course.group > 0) ? course.group : null)));
  const groupSuffix = classNum ? ` (C${classNum})` : '';
  const isPractical = (detectedType || allocType) === 'P';

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
      const facObj = (state.faculty || []).find(f => f.code === code);
      return facObj ? facObj.name : code;
    }).join(' / ');
    const cleanName = (course.name || course.code).replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, '');
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
    btnPrint.onclick = async () => {
      const mode = selectMode ? selectMode.value : 'medium';
      const facCode = selectFac ? selectFac.value : 'ALL';
      if (printArea) await renderAdminTeacherTimetables(printArea, adminActiveTeacherDept, facCode, mode);
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
  const deptUpper = (deptName || '').trim().toUpperCase();
  const deptFaculty = (state.faculty || []).filter(f => (f.department || '').trim().toUpperCase() === deptUpper);
  const periods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
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

  // Also initialize any faculty cross-allocated in this department's timetable
  Object.values(deptAlloc).forEach(dayObj => {
    Object.values(dayObj || {}).forEach(periodObj => {
      Object.values(periodObj || {}).forEach(facList => {
        if (Array.isArray(facList)) {
          facList.forEach(facCode => {
            const fcNorm = (facCode || '').trim();
            if (fcNorm && !schedules[fcNorm]) {
              const facObj = (state.faculty || []).find(f => (f.code || '').trim().toUpperCase() === fcNorm.toUpperCase()) || {
                code: fcNorm,
                name: fcNorm,
                department: deptName,
                designation: 'Faculty Member'
              };
              schedules[fcNorm] = {
                info: facObj,
                totalHours: 0,
                theoryHours: 0,
                practicalHours: 0,
                slots: {}
              };
              weekdays.forEach(d => {
                schedules[fcNorm].slots[d] = {};
              });
            }
          });
        }
      });
    });
  });

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
    const course = (state.courses || []).find(c => c.code === cCode) || 
                   (state.courses || []).find(c => c.code === baseCode) || 
                   { code: cCode, name: cCode, alias: cCode, semester: '-', category: '-', courseType: 'T' };

    const classMatch = cCode.match(/(_C|_G)(\d+)/);
    const classSuffix = classMatch ? ` (C${classMatch[2]})` : '';
    const cleanAlias = (course.alias || course.name || cCode).replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
    const dispAlias = cleanAlias + classSuffix;

    Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (Array.isArray(facList) && facList.length > 0) {
          const slotType = determineSlotType(course, cCode, dayUpper, period, facList, periodObj);
          const isPrac = (slotType === 'P');

          facList.forEach(facCode => {
            const fc = (facCode || '').trim();
            const schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase()) || fc;
            if (schedules[schedKey]) {
              if (!schedules[schedKey].slots[dayUpper]) {
                schedules[schedKey].slots[dayUpper] = {};
              }
              if (!schedules[schedKey].slots[dayUpper][period]) {
                schedules[schedKey].slots[dayUpper][period] = [];
              }
              const already = schedules[schedKey].slots[dayUpper][period].some(x => x.courseCode === cCode);
              if (!already) {
                const coTeachers = facList.filter(f => f.trim().toUpperCase() !== fc.toUpperCase());
                schedules[schedKey].slots[dayUpper][period].push({
                  courseCode: cCode,
                  courseName: course.name || cCode,
                  courseAlias: dispAlias,
                  semester: course.semester,
                  category: course.category,
                  roomNo: course.roomNo || '',
                  section: classSuffix ? classSuffix.trim() : '',
                  coTeachers: coTeachers,
                  type: isPrac ? 'P' : 'T'
                });
                schedules[schedKey].totalHours++;
                if (isPrac) schedules[schedKey].practicalHours++;
                else schedules[schedKey].theoryHours++;
              }
            }
          });
        }
      });
    });
  });

  // Include Approved Cross-Department Assignments in faculty schedules
  let crossDeptReqs = state.crossDepartmentRequests || [];
  if (!crossDeptReqs.length) {
    try {
      const cdRes = await fetch(`${API_BASE}/cross-dept-requests`, { headers: { 'Authorization': sessionStorage.getItem('token') || '' } });
      if (cdRes.ok) {
        const cdData = await cdRes.json();
        crossDeptReqs = cdData.requests || [];
        state.crossDepartmentRequests = crossDeptReqs;
      }
    } catch (e) {}
  }

  const deptUpperNorm = deptUpper.replace(/^DEPARTMENT\s+OF\s+/i, '').trim();
  (crossDeptReqs || []).filter(r => r.status === 'APPROVED' && r.assignedFacultyCode).forEach(r => {
    const fc = (r.assignedFacultyCode || '').trim();
    if (!fc) return;

    let schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase());
    if (!schedKey) {
      const facObj = (state.faculty || []).find(f => (f.code || '').trim().toUpperCase() === fc.toUpperCase());
      const fDeptNorm = (facObj && facObj.department ? facObj.department : '').trim().toUpperCase().replace(/^DEPARTMENT\s+OF\s+/i, '').trim();
      if (facObj && (!deptUpperNorm || fDeptNorm === deptUpperNorm)) {
        schedules[facObj.code] = {
          info: facObj,
          totalHours: 0,
          theoryHours: 0,
          practicalHours: 0,
          slots: {}
        };
        weekdays.forEach(d => { schedules[facObj.code].slots[d] = {}; });
        schedKey = facObj.code;
      }
    }

    if (schedules[schedKey]) {
      const courseObj = (state.courses || []).find(c => c.code === r.courseCode) || {
        code: r.courseCode,
        name: r.courseName || r.courseCode,
        alias: r.courseCode,
        semester: r.semester || '-'
      };
      const cleanAlias = (courseObj.alias || r.courseName || r.courseCode).replace(/-(T|P)$/, '');
      const reqDeptDisplay = r.requestingDept ? r.requestingDept.replace(/^DEPARTMENT\s+OF\s+/i, '').trim() : 'Cross-Dept';

      (r.pinnedSlots || []).forEach(slot => {
        const dayUpper = (slot.day || '').toUpperCase();
        const period = String(slot.period || '').trim();
        if (!dayUpper || !period) return;
        const isPrac = (slot.type === 'P' || (!slot.type && r.courseType === 'P'));

        if (!schedules[schedKey].slots[dayUpper]) schedules[schedKey].slots[dayUpper] = {};
        if (!schedules[schedKey].slots[dayUpper][period]) schedules[schedKey].slots[dayUpper][period] = [];

        const already = schedules[schedKey].slots[dayUpper][period].some(x => x.courseCode === r.courseCode && x.isCrossDept);
        if (!already) {
          schedules[schedKey].slots[dayUpper][period].push({
            courseCode: r.courseCode,
            courseName: `${r.courseName || courseObj.name || r.courseCode} (${reqDeptDisplay})`,
            courseAlias: `${cleanAlias} [${reqDeptDisplay}]`,
            semester: r.semester || courseObj.semester,
            category: `Cross-Dept (${reqDeptDisplay})`,
            roomNo: courseObj.roomNo || '',
            section: '',
            coTeachers: [],
            type: isPrac ? 'P' : 'T',
            isCrossDept: true,
            requestingDept: reqDeptDisplay
          });
          schedules[schedKey].totalHours++;
          if (isPrac) schedules[schedKey].practicalHours++;
          else schedules[schedKey].theoryHours++;
        }
      });
    }
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
            const coTeacherHtml = (item.coTeachers && item.coTeachers.length > 0)
              ? `<div class="teacher-slot-coteacher" style="font-size: 10px; color: #166534; font-weight: 700; margin-top: 2px;"><i class="fa-solid fa-users" style="font-size: 9px;"></i> with ${item.coTeachers.join(', ')}</div>`
              : '';
            const roomHtml = item.roomNo
              ? `<span class="teacher-slot-room" style="font-size: 10px; opacity: 0.85; font-weight: 600;">[Rm: ${item.roomNo}]</span>`
              : '';

            return `
              <div class="teacher-slot-inner">
                <span class="teacher-slot-course" title="${item.courseName} (${item.courseCode})">${dispText}</span>
                <div style="display: flex; gap: 4px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 2px;">
                  ${semLabel ? `<span class="teacher-slot-sem-pill">${semLabel}</span>` : ''}
                  ${roomHtml}
                  <span class="teacher-slot-type-badge">${typeLabel}</span>
                </div>
                ${coTeacherHtml}
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

  const groupCourses = state.courses.filter(c => (c.group && c.group > 0) || (c.class && c.class > 0) || (c.classes && c.classes > 1) || /(_G|_C)\d+/.test(c.code));
  if (groupCourses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No class/section courses found. Import a course Excel with Class column values or configure classes in department portal.</td></tr>';
    return;
  }

  const uniqGroupCourses = [];
  groupCourses.forEach(c => {
    if (!uniqGroupCourses.some(uc => uc.code === c.code)) uniqGroupCourses.push(c);
  });

  uniqGroupCourses.forEach(c => {
    const tr = document.createElement('tr');
    const mapped = c.mappedBatches || [];
    const baseCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
    const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 1);

    tr.innerHTML = `
      <td><strong>${baseCode}</strong></td>
      <td>${c.name}</td>
      <td><span class="badge" style="background:var(--accent);color:var(--accent-dark);font-weight:bold;border:1.5px solid var(--accent-dark);">C${classNum}</span></td>
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

  const baseCode = course.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumMatch = course.code.match(/(_G|_C)(\d+)/);
  const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (course.class || course.group || 1);
  document.getElementById('mapping-course-code').value = course.code;
  
  if (isSingleSelect) {
    document.getElementById('mapping-course-title').textContent = `Assign Batch for Major Course: ${baseCode} — ${course.name}`;
  } else {
    document.getElementById('mapping-course-title').textContent = `${baseCode} (Class C${classNum}) — ${course.name}`;
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
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;transition:background 0.15s;';
      div.onmouseenter = () => div.style.background = '#f1f5f9';
      div.onmouseleave = () => div.style.background = 'transparent';

      div.innerHTML = `
        <input type="checkbox" id="cb-batch-${batch.batchId}" value="${batch.batchId}" ${isChecked ? 'checked' : ''}>
        <label for="cb-batch-${batch.batchId}" style="cursor:pointer;font-size:13px;flex-grow:1;margin:0;">
          <strong>${batch.batchId}</strong>
          <span class="text-muted" style="font-size:11px;"> — ${batch.batchLabel || ''}</span>
        </label>
        ${isSingleSelect ? `
          <button type="button" class="btn btn-primary btn-sm btn-assign-direct" style="padding: 2px 10px; font-size: 11px; font-weight: 600; white-space: nowrap;">
            <i class="fa-solid fa-check"></i> Assign
          </button>
        ` : ''}
      `;

      // Direct assign button for single select mode
      if (isSingleSelect) {
        const btnDirect = div.querySelector('.btn-assign-direct');
        if (btnDirect) {
          btnDirect.addEventListener('click', async (e) => {
            e.stopPropagation();
            await saveBatchMapping(course.code, [batch.batchId], `Assigned batch ${batch.batchId} to ${course.code}`);
          });
        }
      }

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

  const majorCourses = (state.courses || []).filter(c => !c.group || c.group === 0);
  if (majorCourses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No major courses found.</td></tr>';
    return;
  }

  // Sort unassigned courses to the top of the list
  majorCourses.sort((a, b) => {
    const aAssigned = (state.groupMappings[a.code] && state.groupMappings[a.code].length > 0) ? 1 : 0;
    const bAssigned = (state.groupMappings[b.code] && state.groupMappings[b.code].length > 0) ? 1 : 0;
    if (aAssigned !== bAssigned) return aAssigned - bAssigned; // 0 (unassigned) first
    if (a.department !== b.department) return (a.department || '').localeCompare(b.department || '');
    if (a.semester !== b.semester) return (a.semester || 0) - (b.semester || 0);
    return (a.code || '').localeCompare(b.code || '');
  });

  majorCourses.forEach(c => {
    const recBatch = getRecommendedBatchForCourse(c);
    const assignedBatches = state.groupMappings[c.code] || [];
    const currentSelection = assignedBatches.length > 0 ? assignedBatches[0] : '';

    const tr = document.createElement('tr');
    const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
    const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 0);
    const cleanCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const codeDisplay = classNum
      ? `${cleanCode} <span class="badge" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px;">C${classNum}</span>`
      : cleanCode;
    tr.innerHTML = `
      <td><strong>${codeDisplay}</strong></td>
      <td>${c.name}</td>
      <td><span class="badge badge-info">${c.semester} Sem</span></td>
      <td><span class="text-sm text-muted">${c.department}</span></td>
      <td><span class="badge badge-outline">${c.programType || 'UG'}</span></td>
      <td>
        ${recBatch ? `<span class="badge badge-success-light text-success">${recBatch}</span>` : '<span class="text-muted text-sm">N/A</span>'}
      </td>
      <td>
        <button class="btn btn-outline btn-sm btn-major-select-batch-trigger" style="font-weight:600; font-size:12px; min-width: 140px; ${!currentSelection ? 'border-color: var(--danger); color: var(--danger);' : ''}">
          ${currentSelection ? `<i class="fa-solid fa-layer-group"></i> ${currentSelection}` : '<i class="fa-solid fa-plus-circle"></i> Assign Batch'}
        </button>
      </td>
      <td>
        <button class="btn btn-outline-danger btn-sm btn-clear-major-mapping" style="padding: 2px 8px;" title="Clear Assignment" ${!currentSelection ? 'disabled' : ''}><i class="fa-solid fa-eraser"></i> Clear</button>
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
      await saveBatchMapping(c.code, [], `Cleared batch assignment for ${cleanCode}`);
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
      ? assignedCourses.map(c => {
          const cMatch = c.code.match(/(_G|_C)(\d+)/);
          const cNum = cMatch ? parseInt(cMatch[2]) : (c.class || c.group || 0);
          const cClean = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
          return `<span class="badge badge-info" style="margin-right:4px;" title="${c.name}">${cClean}${cNum ? ` (C${cNum})` : ''}</span>`;
        }).join('')
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
    const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
        const token = sessionStorage.getItem('adminToken') || '';
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
          const token = sessionStorage.getItem('adminToken') || '';
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

// ==========================================================================
// Central Admin Common Subject Mapping
// ==========================================================================

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COMMON_SUBJECT_DEFINITIONS = [
  // Semester 1
  {
    code: 'AEC1',
    name: 'Ability Enhancement Course 1 (AEC1)',
    category: 'AEC',
    semester: '1',
    departments: ['ENGLISH'],
    desc: 'Offered exclusively by English Department for Semester 1 students.'
  },
  {
    code: 'AEC2',
    name: 'Ability Enhancement Course 2 (AEC2)',
    category: 'AEC',
    semester: '1',
    departments: ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'],
    desc: 'Language & Ability course for Semester 1 students across Malayalam, English, Hindi, and Sanskrit.'
  },
  {
    code: 'MDC1',
    name: 'Multi-Disciplinary Course 1 (MDC1)',
    category: 'MDC',
    semester: '1',
    departments: 'ALL',
    desc: 'Institution-wide multidisciplinary course for all Semester 1 students across all departments.'
  },
  // Semester 2
  {
    code: 'AEC3',
    name: 'Ability Enhancement Course 3 (AEC3)',
    category: 'AEC',
    semester: '2',
    departments: ['ENGLISH'],
    desc: 'Offered exclusively by English Department for Semester 2 students.'
  },
  {
    code: 'AEC4',
    name: 'Ability Enhancement Course 4 (AEC4)',
    category: 'AEC',
    semester: '2',
    departments: ['ENGLISH', 'MALAYALAM', 'HINDI', 'SANSKRIT'],
    desc: 'Language & Ability course for Semester 2 students across English, Malayalam, Hindi, and Sanskrit.'
  },
  {
    code: 'MDC-2',
    name: 'Multi-Disciplinary Course 2 (MDC-2)',
    category: 'MDC',
    semester: '2',
    departments: 'ALL',
    desc: 'Institution-wide multidisciplinary course for all Semester 2 students across all departments.'
  },
  // Semester 3
  {
    code: 'VAC1',
    name: 'Value Addition Course 1 (VAC1)',
    category: 'VAC',
    semester: '3',
    departments: ['ENGLISH'],
    desc: 'Value Addition Course for Semester 3 students, offered by English Department.'
  },
  {
    code: 'MDC3',
    name: 'Multi-Disciplinary Course 3 (MDC3)',
    category: 'MDC',
    semester: '3',
    departments: ['ENGLISH'],
    desc: 'Multi-Disciplinary Course for Semester 3 students, offered by English Department.'
  },
  // Semester 4
  {
    code: 'VAC2',
    name: 'Value Addition Course 2 (VAC2)',
    category: 'VAC',
    semester: '4',
    departments: ['ENGLISH'],
    desc: 'Value Addition Course for Semester 4 students, offered by English Department.'
  },
  {
    code: 'SEC',
    name: 'Skill Enhancement Course (SEC)',
    category: 'SEC',
    semester: '4',
    departments: ['ENGLISH'],
    desc: 'Skill Enhancement Course for Semester 4/5 students.'
  },
  {
    code: 'VAC3',
    name: 'Value Addition Course 3 (VAC3)',
    category: 'VAC',
    semester: '4',
    departments: ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'],
    desc: 'Value Addition Course for Semester 4 students across Malayalam, English, Hindi, and Sanskrit.'
  }
];

function getCourseCommonSubjectMatch(c) {
  const cat = (c.category || '').toUpperCase();
  const sem = String(c.semester || '').trim();
  const dept = (c.department || '').toUpperCase();
  const code = (c.code || '').toUpperCase();

  // Sem 1
  if (sem === '1') {
    if (cat === 'AEC' || code.includes('FA101') || code.includes('FA102') || /AEC1|AEC-1/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'AEC1';
      return 'AEC2';
    }
    if (cat === 'MDC' || code.includes('FM105') || /MDC1|MDC-1/.test(code)) return 'MDC1';
  }
  // Sem 2
  if (sem === '2') {
    if (cat === 'AEC' || /AEC3|AEC-3/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'AEC3';
      return 'AEC4';
    }
    if (cat === 'MDC' || /MDC2|MDC-2/.test(code)) return 'MDC-2';
  }
  // Sem 3
  if (sem === '3') {
    if (cat === 'VAC' || code.includes('FV108') || /VAC1|VAC-1/.test(code)) return 'VAC1';
    if (cat === 'MDC' || code.includes('FM107') || /MDC3|MDC-3/.test(code)) return 'MDC3';
  }
  // Sem 4
  if (sem === '4') {
    if (cat === 'SEC' || /SEC/.test(code)) return 'SEC';
    if (cat === 'VAC' || /VAC2|VAC-2/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'VAC2';
      return 'VAC3';
    }
  }
  // Sem 5 SEC
  if (sem === '5' && (cat === 'SEC' || /SEC/.test(code))) return 'SEC';

  // Fallbacks by category
  if (cat === 'AEC') return sem === '2' ? 'AEC3' : 'AEC1';
  if (cat === 'MDC') return sem === '3' ? 'MDC3' : (sem === '2' ? 'MDC-2' : 'MDC1');
  if (cat === 'VAC') return sem === '4' ? 'VAC2' : 'VAC1';
  if (cat === 'SEC') return 'SEC';
  return null;
}

let activeAdminCommonSubjectCode = null;

function renderAdminCommonSubjectMapping() {
  const mainView = document.getElementById('admin-common-main-view');
  const detailView = document.getElementById('admin-common-detail-view');
  const grid = document.getElementById('admin-common-tiles-grid');
  const semFilter = document.getElementById('admin-common-sem-filter');
  if (!grid) return;

  if (activeAdminCommonSubjectCode) {
    openAdminCommonSubjectDetail(activeAdminCommonSubjectCode);
    return;
  }

  if (mainView) mainView.classList.remove('hidden');
  if (detailView) detailView.classList.add('hidden');

  let visibleSubjects = [...COMMON_SUBJECT_DEFINITIONS];
  const selectedSem = semFilter ? semFilter.value : '';
  if (selectedSem) {
    if (selectedSem === 'odd') {
      visibleSubjects = visibleSubjects.filter(s => parseInt(String(s.semester).replace(/\D+/g, ''), 10) % 2 === 1);
    } else if (selectedSem === 'even') {
      visibleSubjects = visibleSubjects.filter(s => parseInt(String(s.semester).replace(/\D+/g, ''), 10) % 2 === 0);
    } else {
      visibleSubjects = visibleSubjects.filter(s => String(s.semester) === String(selectedSem));
    }
  }

  grid.innerHTML = visibleSubjects.map(def => {
    const matchingCourses = state.courses.filter(c => getCourseCommonSubjectMatch(c) === def.code);
    let totalMappedBatches = 0;
    const mappedBatchSet = new Set();
    matchingCourses.forEach(c => {
      (c.mappedBatches || []).forEach(b => mappedBatchSet.add(b));
    });
    totalMappedBatches = mappedBatchSet.size;

    const deptStr = Array.isArray(def.departments) ? def.departments.join(', ') : def.departments;

    return `
      <div class="common-subject-card" onclick="openAdminCommonSubjectDetail('${def.code}')" style="cursor: pointer; background: #ffffff; border: 1.5px solid var(--border); border-radius: var(--radius-md); padding: 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; transition: all 0.2s ease; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="subject-code-badge" style="background: #e0e7ff; color: #4338ca; padding: 3px 8px; border-radius: 5px; font-weight: 700; font-size: 12px;">${def.code}</span>
            <span class="subject-sem-tag" style="background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">Sem ${def.semester}</span>
          </div>
          <h4 style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700; color: var(--text-main);">${escapeHtml(def.name)}</h4>
          <p class="text-muted" style="font-size: 11.5px; margin: 0 0 8px 0; line-height: 1.4;">${escapeHtml(def.desc)}</p>
          <span style="font-size: 11px; color: var(--primary); font-weight: 600; display: inline-block;">
            <i class="fa-solid fa-building-columns"></i> ${escapeHtml(deptStr)}
          </span>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px;">
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="badge ${matchingCourses.length > 0 ? 'badge-info' : ''}" style="${matchingCourses.length === 0 ? 'background: #f1f5f9; color: #64748b;' : ''}">
              <i class="fa-solid fa-book"></i> ${matchingCourses.length} Class${matchingCourses.length === 1 ? '' : 'es'}
            </span>
            <span class="badge ${totalMappedBatches > 0 ? 'badge-success' : ''}" style="${totalMappedBatches === 0 ? 'background: #f1f5f9; color: #64748b;' : ''}">
              <i class="fa-solid fa-users"></i> ${totalMappedBatches} Batches
            </span>
          </div>
          <span style="color: var(--primary); font-weight: 700; display: flex; align-items: center; gap: 4px;">
            Manage <i class="fa-solid fa-arrow-right"></i>
          </span>
        </div>
      </div>
    `;
  }).join('');
}

window.openAdminCommonSubjectDetail = function(subjectCode) {
  activeAdminCommonSubjectCode = subjectCode;
  const mainView = document.getElementById('admin-common-main-view');
  const detailView = document.getElementById('admin-common-detail-view');
  if (mainView) mainView.classList.add('hidden');
  if (detailView) detailView.classList.remove('hidden');

  const def = COMMON_SUBJECT_DEFINITIONS.find(d => d.code === subjectCode) || {
    code: subjectCode,
    name: subjectCode,
    semester: '1',
    departments: 'ALL',
    desc: ''
  };

  const codeBadge = document.getElementById('admin-detail-subject-code-badge');
  const titleEl = document.getElementById('admin-detail-subject-title');
  const semTag = document.getElementById('admin-detail-subject-sem-tag');
  const deptBadge = document.getElementById('admin-detail-offering-dept-badge');
  const container = document.getElementById('admin-common-classes-container');

  if (codeBadge) codeBadge.textContent = def.code;
  if (titleEl) titleEl.textContent = def.name;
  if (semTag) semTag.textContent = `Semester ${def.semester}`;
  const deptStr = Array.isArray(def.departments) ? def.departments.join(', ') : def.departments;
  if (deptBadge) deptBadge.textContent = `Offered by: ${deptStr}`;

  if (!container) return;

  // Find all courses matching this common subject
  const matchingCourses = state.courses.filter(c => getCourseCommonSubjectMatch(c) === def.code);

  if (matchingCourses.length === 0) {
    container.innerHTML = `
      <div style="background: #ffffff; border: 1.5px dashed var(--border); border-radius: var(--radius-md); padding: 36px 20px; text-align: center;">
        <i class="fa-solid fa-folder-open text-muted" style="font-size: 32px; margin-bottom: 10px;"></i>
        <h4 style="margin: 0 0 4px 0; font-size: 15px; font-weight: 700;">No Connected Courses Found</h4>
        <p class="text-muted text-xs mb-0">No courses in the academic curriculum currently match the definition for ${def.code} (Semester ${def.semester}).</p>
      </div>
    `;
    return;
  }

  // Group courses by base code
  const groups = {};
  matchingCourses.forEach(c => {
    const baseCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    if (!groups[baseCode]) {
      groups[baseCode] = {
        baseCode,
        name: c.name,
        department: c.department,
        semester: c.semester,
        courses: []
      };
    }
    groups[baseCode].courses.push(c);
  });

  // Sort groups and their courses
  const sortedGroupKeys = Object.keys(groups).sort();

  container.innerHTML = sortedGroupKeys.map(baseCode => {
    const grp = groups[baseCode];
    grp.courses.sort((a, b) => {
      const matchA = a.code.match(/(_G|_C)(\d+)/);
      const matchB = b.code.match(/(_G|_C)(\d+)/);
      const numA = matchA ? parseInt(matchA[2]) : (a.class || 1);
      const numB = matchB ? parseInt(matchB[2]) : (b.class || 1);
      return numA - numB;
    });

    const rowsHtml = grp.courses.map(c => {
      const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
      const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 1);
      const mapped = c.mappedBatches || [];

      // Look up assigned teacher from Subject Teacher Mapping in the offering department
      const deptUpper = (c.department || '').toUpperCase();
      const teacherMap = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptUpper] && state.subjectTeacherMapping[deptUpper][c.code]) || null;
      let teacherInfoHtml = '';
      if (teacherMap && (
        (teacherMap.teachers && teacherMap.teachers.length > 0) ||
        (teacherMap.theoryTeachers && teacherMap.theoryTeachers.length > 0) ||
        (teacherMap.practicalTeachers && teacherMap.practicalTeachers.length > 0)
      )) {
        const tCodes = [...new Set([
          ...(teacherMap.teachers || []),
          ...(teacherMap.theoryTeachers || []),
          ...(teacherMap.practicalTeachers || [])
        ])];
        const teacherLabels = tCodes.map(tc => {
          const fObj = (state.faculty || []).find(f => f.code === tc);
          return fObj ? `${tc} (${fObj.name})` : tc;
        });
        teacherInfoHtml = `<span class="badge badge-success" style="font-size: 11px;"><i class="fa-solid fa-chalkboard-user"></i> ${escapeHtml(teacherLabels.join(', '))}</span>`;
      } else {
        teacherInfoHtml = `<span class="badge" style="background: #fef3c7; color: #b45309; font-size: 10.5px;"><i class="fa-solid fa-clock"></i> Pending Dept Mapping</span>`;
      }

      // Mapped batch pills with Department tooltip
      const batchPillsHtml = mapped.length > 0
        ? mapped.map(bId => {
            const bObj = (state.allBatches || []).find(b => b.batchId === bId);
            const deptLabel = bObj ? ` - ${bObj.deptCode || bObj.department}` : '';
            return `<span class="badge badge-info" style="margin: 2px;" title="${bId}${deptLabel}">${bId}${deptLabel}</span>`;
          }).join('')
        : `<span class="text-muted text-sm" style="font-style: italic;">No batches mapped</span>`;

      return `
        <tr style="border-bottom: 1px solid var(--border);">
          <td style="padding: 10px 12px; vertical-align: middle;">
            <span class="badge" style="background: var(--accent); color: var(--accent-dark); font-weight: 700; border: 1.5px solid var(--accent-dark); font-size: 11.5px; padding: 3px 8px;">
              Class C${classNum}
            </span>
          </td>
          <td style="padding: 10px 12px; vertical-align: middle;">
            <strong style="color: var(--text-main); font-size: 12.5px;">${escapeHtml(c.code)}</strong>
          </td>
          <td style="padding: 10px 12px; vertical-align: middle;">
            <div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
              ${batchPillsHtml}
            </div>
          </td>
          <td style="padding: 10px 12px; vertical-align: middle;">
            ${teacherInfoHtml}
          </td>
          <td style="padding: 10px 12px; vertical-align: middle; text-align: right;">
            <button type="button" class="btn btn-primary btn-sm btn-admin-map-batch" data-code="${escapeHtml(c.code)}" style="padding: 3px 10px; font-size: 11px;">
              <i class="fa-solid fa-link"></i> Map Batches
            </button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="card" style="border: 1px solid var(--border); box-shadow: 0 1px 4px rgba(0,0,0,0.04); margin-bottom: 12px;">
        <div class="card-header" style="background: #f8fafc; padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div>
            <strong style="font-size: 14px; color: var(--primary);">${escapeHtml(grp.baseCode)}</strong>
            <span style="font-size: 13px; font-weight: 600; color: var(--text-main); margin-left: 8px;">${escapeHtml(grp.name)}</span>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span class="badge badge-info" style="font-size: 10px;">Dept: ${escapeHtml(grp.department)}</span>
            <span class="badge" style="background: #e2e8f0; color: #334155; font-size: 10px; font-weight: 600;">Sem ${escapeHtml(grp.semester)}</span>
            <span class="badge badge-success" style="font-size: 10px;">${grp.courses.length} Parallel Class${grp.courses.length === 1 ? '' : 'es'}</span>
          </div>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="table" style="margin: 0; width: 100%; font-size: 12px;">
              <thead>
                <tr style="background: #ffffff; border-bottom: 1.5px solid var(--border);">
                  <th style="padding: 8px 12px; width: 90px;">Class</th>
                  <th style="padding: 8px 12px; width: 180px;">Course Code</th>
                  <th style="padding: 8px 12px;">Mapped Batches (from Batch Allocation)</th>
                  <th style="padding: 8px 12px; width: 220px;">Assigned Teacher (Dept Mapping)</th>
                  <th style="padding: 8px 12px; width: 130px; text-align: right;">Action</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Attach event handlers to Map Batches buttons
  container.querySelectorAll('.btn-admin-map-batch').forEach(btn => {
    btn.addEventListener('click', () => {
      const cCode = btn.getAttribute('data-code');
      const courseObj = state.courses.find(c => c.code === cCode);
      if (courseObj) {
        openGroupMappingModal(courseObj, courseObj.mappedBatches || []);
      }
    });
  });
};

// ==========================================================================
// FREE FACULTY / STAFF ROOM ROSTER & AVAILABILITY MATRIX
// ==========================================================================
const freeFacultyState = {
  initialized: false,
  data: null,
  filters: {
    day: 'MONDAY',
    period: '1',
    dept: 'ALL',
    program: 'ALL',
    sem: 'ALL',
    sort: 'name-asc',
    search: '',
    viewMode: 'roster'
  }
};

async function renderFreeFacultySection(forceReload = false) {
  initFreeFacultyControls();

  if (!freeFacultyState.data || forceReload) {
    const rosterTbody = document.querySelector('#table-free-faculty-roster tbody');
    const matrixTbody = document.querySelector('#table-free-faculty-matrix tbody');
    if (rosterTbody) {
      rosterTbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted"><i class="fa-solid fa-spinner fa-spin text-primary"></i> Checking all faculty schedules across departments...</td></tr>`;
    }
    if (matrixTbody) {
      matrixTbody.innerHTML = `<tr><td colspan="10" class="text-center py-4 text-muted"><i class="fa-solid fa-spinner fa-spin text-primary"></i> Compiling weekly timetable matrix...</td></tr>`;
    }

    try {
      const res = await fetch(`${API_BASE}/admin/free-faculty`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      freeFacultyState.data = await res.json();
      populateFreeFacultyDepartments();
    } catch (err) {
      console.error('Failed to load free faculty data:', err);
      if (rosterTbody) {
        rosterTbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-danger"><i class="fa-solid fa-triangle-exclamation"></i> Error loading faculty availability: ${escapeHtml(err.message)}</td></tr>`;
      }
      return;
    }
  }

  applyFreeFacultyFilters();
}

function initFreeFacultyControls() {
  if (freeFacultyState.initialized) return;
  freeFacultyState.initialized = true;

  // Intelligently default to today's weekday if Monday to Friday
  const weekdayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const currentDayIndex = new Date().getDay();
  if (currentDayIndex >= 1 && currentDayIndex <= 5) {
    freeFacultyState.filters.day = weekdayNames[currentDayIndex];
  }

  // Update day pill UI to reflect default day
  const dayPills = document.querySelectorAll('#free-fac-day-pills .day-pill');
  dayPills.forEach(pill => {
    const d = pill.getAttribute('data-day');
    if (d === freeFacultyState.filters.day) {
      pill.classList.add('active', 'btn-primary');
      pill.classList.remove('btn-outline');
    } else {
      pill.classList.remove('active', 'btn-primary');
      pill.classList.add('btn-outline');
    }

    pill.addEventListener('click', () => {
      dayPills.forEach(p => {
        p.classList.remove('active', 'btn-primary');
        p.classList.add('btn-outline');
      });
      pill.classList.add('active', 'btn-primary');
      pill.classList.remove('btn-outline');
      freeFacultyState.filters.day = pill.getAttribute('data-day');
      applyFreeFacultyFilters();
    });
  });

  // Period pills
  const periodPills = document.querySelectorAll('#free-fac-period-pills .period-pill');
  periodPills.forEach(pill => {
    pill.addEventListener('click', () => {
      periodPills.forEach(p => {
        p.classList.remove('active', 'btn-primary');
        p.classList.add('btn-outline');
      });
      pill.classList.add('active', 'btn-primary');
      pill.classList.remove('btn-outline');
      freeFacultyState.filters.period = pill.getAttribute('data-period');
      applyFreeFacultyFilters();
    });
  });

  // View mode toggles
  const btnRoster = document.getElementById('btn-view-mode-roster');
  const btnMatrix = document.getElementById('btn-view-mode-matrix');
  const viewRoster = document.getElementById('view-free-faculty-roster');
  const viewMatrix = document.getElementById('view-free-faculty-matrix');

  if (btnRoster && btnMatrix) {
    btnRoster.addEventListener('click', () => {
      freeFacultyState.filters.viewMode = 'roster';
      btnRoster.classList.add('btn-primary');
      btnRoster.classList.remove('btn-outline');
      btnMatrix.classList.remove('btn-primary');
      btnMatrix.classList.add('btn-outline');
      if (viewRoster) viewRoster.classList.remove('hidden');
      if (viewMatrix) viewMatrix.classList.add('hidden');
      applyFreeFacultyFilters();
    });

    btnMatrix.addEventListener('click', () => {
      freeFacultyState.filters.viewMode = 'matrix';
      btnMatrix.classList.add('btn-primary');
      btnMatrix.classList.remove('btn-outline');
      btnRoster.classList.remove('btn-primary');
      btnRoster.classList.add('btn-outline');
      if (viewMatrix) viewMatrix.classList.remove('hidden');
      if (viewRoster) viewRoster.classList.add('hidden');
      applyFreeFacultyFilters();
    });
  }

  // Dropdown filter events
  const selDept = document.getElementById('select-free-dept');
  if (selDept) {
    selDept.addEventListener('change', (e) => {
      freeFacultyState.filters.dept = e.target.value;
      applyFreeFacultyFilters();
    });
  }

  const selProgram = document.getElementById('select-free-program');
  if (selProgram) {
    selProgram.addEventListener('change', (e) => {
      freeFacultyState.filters.program = e.target.value;
      applyFreeFacultyFilters();
    });
  }

  const selSem = document.getElementById('select-free-sem');
  if (selSem) {
    selSem.addEventListener('change', (e) => {
      freeFacultyState.filters.sem = e.target.value;
      applyFreeFacultyFilters();
    });
  }

  const selSort = document.getElementById('select-free-sort');
  if (selSort) {
    selSort.addEventListener('change', (e) => {
      freeFacultyState.filters.sort = e.target.value;
      applyFreeFacultyFilters();
    });
  }

  // Quick search input
  const inputSearch = document.getElementById('input-free-search');
  if (inputSearch) {
    inputSearch.addEventListener('input', (e) => {
      freeFacultyState.filters.search = e.target.value.trim().toLowerCase();
      applyFreeFacultyFilters();
    });
  }

  // Refresh button
  const btnRefresh = document.getElementById('btn-refresh-free-faculty');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      renderFreeFacultySection(true);
    });
  }

  // CSV Export button
  const btnExportCsv = document.getElementById('btn-export-free-faculty-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      exportFreeFacultyCSV();
    });
  }

  // Print button
  const btnPrint = document.getElementById('btn-print-free-faculty');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      printFreeFacultyRoster();
    });
  }
}

function populateFreeFacultyDepartments() {
  const selDept = document.getElementById('select-free-dept');
  if (!selDept || !freeFacultyState.data) return;

  const currentVal = selDept.value;
  const departments = freeFacultyState.data.departments || [];

  selDept.innerHTML = `<option value="ALL">All Departments (${departments.length})</option>`;
  departments.forEach(dept => {
    const opt = document.createElement('option');
    opt.value = dept;
    opt.textContent = dept;
    selDept.appendChild(opt);
  });

  if (departments.includes(currentVal)) {
    selDept.value = currentVal;
  }
}

function applyFreeFacultyFilters() {
  if (!freeFacultyState.data || !freeFacultyState.data.faculty) return;

  const { day, period, dept, program, sem, sort, search, viewMode } = freeFacultyState.filters;
  const allFaculty = freeFacultyState.data.faculty;

  // 1. Compute Slot info label for metrics ribbon
  const dayDisplay = day === 'ALL' ? 'All Weekdays' : day.charAt(0) + day.slice(1).toLowerCase();
  const periodDisplay = period === 'ALL' ? 'All Periods' : `Period ${period}`;
  const slotText = (day === 'ALL' && period === 'ALL')
    ? 'All Days & Periods'
    : (day === 'ALL' ? `Every Day, ${periodDisplay}` : (period === 'ALL' ? `${dayDisplay}, All Periods` : `${dayDisplay}, ${periodDisplay}`));

  const statSlotInfo = document.getElementById('stat-slot-info');
  const statSlotSubinfo = document.getElementById('stat-slot-subinfo');
  if (statSlotInfo) statSlotInfo.textContent = `${day === 'ALL' ? 'All' : day.slice(0,3)} ${period === 'ALL' ? 'All' : 'P' + period}`;
  if (statSlotSubinfo) statSlotSubinfo.textContent = slotText;

  // 2. Base filter matching department, program, semester, search
  let filtered = allFaculty.filter(fac => {
    // Department filter
    if (dept !== 'ALL' && fac.department !== dept) return false;

    // Program (UG / PG) filter
    if (program !== 'ALL') {
      const hasProg = fac.programs && fac.programs.some(p => p.toUpperCase() === program.toUpperCase());
      if (!hasProg) return false;
    }

    // Semester filter
    if (sem !== 'ALL') {
      const semStr = String(sem);
      const teachesSem = fac.semesters && fac.semesters.some(s => String(s) === semStr);
      if (!teachesSem) return false;
    }

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      const match = (fac.name && fac.name.toLowerCase().includes(q)) ||
                    (fac.code && fac.code.toLowerCase().includes(q)) ||
                    (fac.department && fac.department.toLowerCase().includes(q)) ||
                    (fac.staffId && fac.staffId.toLowerCase().includes(q)) ||
                    (fac.designation && fac.designation.toLowerCase().includes(q));
      if (!match) return false;
    }

    return true;
  });

  // 3. Calculate slot availability metrics among filtered faculty
  let freeInSlotCount = 0;
  let busyInSlotCount = 0;

  filtered.forEach(fac => {
    if (day !== 'ALL' && period !== 'ALL') {
      const slotSched = fac.weeklySchedule?.[day]?.[period];
      fac._isFreeInActiveSlot = Boolean(slotSched && slotSched.free);
      if (fac._isFreeInActiveSlot) {
        freeInSlotCount++;
      } else {
        busyInSlotCount++;
      }
    } else if (day !== 'ALL') {
      const freePeriodsToday = fac.freeSlotsByDay?.[day] || [];
      fac._freeTodayCount = freePeriodsToday.length;
      fac._isFreeInActiveSlot = freePeriodsToday.length > 0;
      if (fac._isFreeInActiveSlot) freeInSlotCount++;
      else busyInSlotCount++;
    } else if (period !== 'ALL') {
      let freeDaysForPeriod = 0;
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].forEach(d => {
        if (fac.weeklySchedule?.[d]?.[period]?.free) freeDaysForPeriod++;
      });
      fac._freeDaysForPeriod = freeDaysForPeriod;
      fac._isFreeInActiveSlot = freeDaysForPeriod > 0;
      if (fac._isFreeInActiveSlot) freeInSlotCount++;
      else busyInSlotCount++;
    } else {
      fac._isFreeInActiveSlot = fac.totalFree > 0;
      if (fac._isFreeInActiveSlot) freeInSlotCount++;
      else busyInSlotCount++;
    }
  });

  // Update top metric cards
  const statFreeCount = document.getElementById('stat-free-count');
  const statBusyCount = document.getElementById('stat-busy-count');
  const statTotalFaculty = document.getElementById('stat-total-faculty');
  if (statFreeCount) statFreeCount.textContent = freeInSlotCount;
  if (statBusyCount) statBusyCount.textContent = busyInSlotCount;
  if (statTotalFaculty) statTotalFaculty.textContent = filtered.length;

  // 4. In Staff Room Roster View, show faculty who are free (resting in staff room)
  let rosterList = filtered;
  if (viewMode === 'roster') {
    if (day !== 'ALL' && period !== 'ALL') {
      rosterList = filtered.filter(f => f._isFreeInActiveSlot);
    } else if (day !== 'ALL') {
      rosterList = filtered.filter(f => (f._freeTodayCount || 0) > 0);
    } else if (period !== 'ALL') {
      rosterList = filtered.filter(f => (f._freeDaysForPeriod || 0) > 0);
    }
  }

  // 5. Apply sorting
  const sortFn = (a, b) => {
    if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'name-desc') return (b.name || '').localeCompare(a.name || '');
    if (sort === 'code-asc') return (a.code || '').localeCompare(b.code || '');
    if (sort === 'dept-asc') return (a.department || '').localeCompare(b.department || '') || (a.name || '').localeCompare(b.name || '');
    if (sort === 'free-desc') return (b.totalFree || 0) - (a.totalFree || 0);
    if (sort === 'free-asc') return (a.totalFree || 0) - (b.totalFree || 0);
    return 0;
  };

  rosterList.sort(sortFn);
  filtered.sort(sortFn);

  // 6. Render view
  if (viewMode === 'roster') {
    renderFreeFacultyRoster(rosterList, slotText);
  } else {
    renderFreeFacultyMatrix(filtered);
  }
}

function renderFreeFacultyRoster(rosterList, slotText) {
  const tbody = document.querySelector('#table-free-faculty-roster tbody');
  const titleEl = document.getElementById('roster-table-title');
  const badgeCount = document.getElementById('badge-free-roster-count');
  const { day, period } = freeFacultyState.filters;

  if (titleEl) {
    titleEl.innerHTML = `<i class="fa-solid fa-mug-hot text-success"></i> Available Faculty in Staff Room &mdash; <span style="font-weight: 500; color: var(--text-muted); font-size: 13px;">${escapeHtml(slotText)}</span>`;
  }
  if (badgeCount) {
    badgeCount.textContent = `${rosterList.length} Faculty Available`;
  }

  if (!tbody) return;

  if (rosterList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-5">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-muted);">
            <i class="fa-solid fa-chalkboard-user" style="font-size: 32px; color: #94a3b8;"></i>
            <strong style="font-size: 14px; color: var(--text-main);">No Faculty Free in Staff Room</strong>
            <p style="font-size: 12px; margin: 0; max-width: 420px;">All matching teachers currently have assigned teaching classes during this period, or no teachers match the current filters.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const effectiveDay = day === 'ALL' ? 'MONDAY' : day;

  tbody.innerHTML = rosterList.map(fac => {
    // Generate Day's Period badges
    const daySched = fac.weeklySchedule?.[effectiveDay] || {};
    const teachingPeriods = freeFacultyState.data.periods || ["1", "2", "3", "4", "5", "6"];
    
    const periodPillsHtml = teachingPeriods.map(p => {
      const isFree = daySched[p] && daySched[p].free;
      const isCurrentSlot = (p === period && (day === 'ALL' || day === effectiveDay));
      if (isFree) {
        const bg = isCurrentSlot ? '#16a34a' : '#dcfce7';
        const color = isCurrentSlot ? '#ffffff' : '#15803d';
        const border = isCurrentSlot ? '1px solid #15803d' : '1px solid #86efac';
        return `<span class="badge" style="background:${bg}; color:${color}; border:${border}; font-weight:700; margin-right:3px; padding:3px 7px; font-size:11px;" title="Period ${p}: Free in Staff Room">P${p}${isCurrentSlot ? ' ✓' : ''}</span>`;
      } else {
        const assign = daySched[p] || {};
        return `<span class="badge" style="background:#f1f5f9; color:#94a3b8; border: 1px solid #e2e8f0; font-weight:500; margin-right:3px; padding:3px 7px; font-size:11px;" title="Period ${p}: Teaching ${escapeHtml(assign.courseAlias || assign.courseCode || '')}">P${p}</span>`;
      }
    }).join('');

    const programsHtml = (fac.programs || []).map(pr => `<span class="badge" style="background: ${pr === 'PG' ? '#fef3c7' : '#e0f2fe'}; color: ${pr === 'PG' ? '#92400e' : '#0369a1'}; font-size: 10px; font-weight: 600;">${pr}</span>`).join(' ');
    const semText = (fac.semesters && fac.semesters.length > 0) ? `Sem ${fac.semesters.join(', ')}` : 'Sem -';

    return `
      <tr>
        <td style="font-family: monospace; font-size: 12px; color: var(--text-muted);">${escapeHtml(fac.staffId || '-')}</td>
        <td><span class="badge" style="background: #ede9fe; color: #5b21b6; font-weight: 700; font-size: 12px; letter-spacing: 0.5px;">${escapeHtml(fac.code)}</span></td>
        <td>
          <div style="line-height: 1.3;">
            <strong style="color: var(--text-main); font-size: 13px;">${escapeHtml(fac.name)}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(fac.designation || 'Faculty Member')}</div>
          </div>
        </td>
        <td>
          <span class="badge badge-info" style="font-size: 11px;">${escapeHtml(fac.department)}</span>
        </td>
        <td>
          <span class="badge" style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; font-weight: 700; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px;">
            <i class="fa-solid fa-mug-hot"></i> Free in Staff Room
          </span>
        </td>
        <td>
          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 2px;">
            ${periodPillsHtml}
          </div>
        </td>
        <td>
          <div style="display: flex; align-items: baseline; gap: 4px;">
            <strong style="color: #16a34a; font-size: 14px;">${fac.totalFree} hrs</strong>
            <span style="font-size: 11px; color: var(--text-muted);">/ ${fac.maxPeriods} hrs</span>
          </div>
          <div style="background: #e2e8f0; height: 4px; border-radius: 2px; width: 85px; margin-top: 4px; overflow: hidden;">
            <div style="background: #16a34a; height: 100%; width: ${Math.round((fac.totalFree / (fac.maxPeriods || 30)) * 100)}%;"></div>
          </div>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <div>
              <strong style="color: var(--primary); font-size: 13px;">${fac.totalBusy} hrs</strong>
              <span style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">${semText}</span>
            </div>
            <div>${programsHtml}</div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderFreeFacultyMatrix(facultyList) {
  const table = document.getElementById('table-free-faculty-matrix');
  if (!table) return;

  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const { day, period } = freeFacultyState.filters;
  const weekdays = freeFacultyState.data.weekdays || ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const teachingPeriods = freeFacultyState.data.periods || ["1", "2", "3", "4", "5", "6"];

  if (day !== 'ALL') {
    // Single Day Matrix: Columns: Staff ID, Code, Name, Dept, P1..P6, Total Free Today
    thead.innerHTML = `
      <tr style="background: #f8fafc;">
        <th style="width: 80px;">Staff ID</th>
        <th style="width: 80px;">Code</th>
        <th>Faculty Name</th>
        <th>Department</th>
        ${teachingPeriods.map(p => `
          <th class="text-center" style="width: 100px; ${p === period ? 'background: rgba(37, 99, 235, 0.08); border-bottom: 2px solid var(--primary);' : ''}">
            Period ${p}
          </th>
        `).join('')}
        <th class="text-center" style="width: 110px;">Day Free</th>
      </tr>
    `;

    if (facultyList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${4 + teachingPeriods.length + 1}" class="text-center py-4 text-muted">No faculty matching selected filters</td></tr>`;
      return;
    }

    tbody.innerHTML = facultyList.map(fac => {
      const daySched = fac.weeklySchedule?.[day] || {};
      const freeSlots = fac.freeSlotsByDay?.[day] || [];

      const periodsHtml = teachingPeriods.map(p => {
        const slot = daySched[p];
        const isFree = slot && slot.free;
        const isTargetSlot = (p === period);

        if (isFree) {
          return `
            <td class="text-center" style="${isTargetSlot ? 'background: #f0fdf4; border: 1.5px solid #86efac;' : 'background: #f8fafc;'}">
              <span class="badge" style="background: #dcfce7; color: #166534; border: 1px solid #86efac; font-weight: 600; padding: 4px 8px; font-size: 11px;">
                <i class="fa-solid fa-mug-hot"></i> Free
              </span>
            </td>
          `;
        } else {
          const assign = slot || {};
          const title = `${assign.courseName || assign.courseCode} (${assign.department}) Sem ${assign.semester}`;
          return `
            <td class="text-center" style="${isTargetSlot ? 'background: #eff6ff; border: 1.5px solid #93c5fd;' : ''}">
              <span class="badge" style="background: #ede9fe; color: #5b21b6; border: 1px solid #c4b5fd; font-weight: 600; padding: 4px 8px; font-size: 11px; max-width: 90px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; display: inline-block;" title="${escapeHtml(title)}">
                <i class="fa-solid fa-chalkboard-user"></i> ${escapeHtml(assign.courseAlias || assign.courseCode || 'Busy')}
              </span>
            </td>
          `;
        }
      }).join('');

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11px; color: var(--text-muted);">${escapeHtml(fac.staffId || '-')}</td>
          <td><span class="badge" style="background: #e2e8f0; color: #334155; font-weight: 700;">${escapeHtml(fac.code)}</span></td>
          <td>
            <strong style="color: var(--text-main); font-size: 13px;">${escapeHtml(fac.name)}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(fac.designation)}</div>
          </td>
          <td><span class="badge badge-info" style="font-size: 11px;">${escapeHtml(fac.department)}</span></td>
          ${periodsHtml}
          <td class="text-center">
            <strong style="color: #16a34a; font-size: 13px;">${freeSlots.length} / ${teachingPeriods.length}</strong>
          </td>
        </tr>
      `;
    }).join('');

  } else {
    // All Days Matrix: Columns: Staff ID, Code, Name, Dept, Mon, Tue, Wed, Thu, Fri, Total Free Week
    thead.innerHTML = `
      <tr style="background: #f8fafc;">
        <th style="width: 80px;">Staff ID</th>
        <th style="width: 80px;">Code</th>
        <th>Faculty Name</th>
        <th>Department</th>
        ${weekdays.map(d => `<th class="text-center" style="min-width: 140px;">${d.charAt(0) + d.slice(1,3).toLowerCase()}</th>`).join('')}
        <th class="text-center" style="width: 110px;">Weekly Free</th>
      </tr>
    `;

    if (facultyList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${4 + weekdays.length + 1}" class="text-center py-4 text-muted">No faculty matching selected filters</td></tr>`;
      return;
    }

    tbody.innerHTML = facultyList.map(fac => {
      const daysHtml = weekdays.map(d => {
        const freeSlots = fac.freeSlotsByDay?.[d] || [];
        const busySlots = fac.busySlotsByDay?.[d] || [];

        const freeBadges = freeSlots.length > 0
          ? freeSlots.map(p => `<span class="badge" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 5px; margin: 1px;">P${p}</span>`).join('')
          : '<span class="text-muted" style="font-size: 11px;">None</span>';

        return `
          <td style="font-size: 11px;">
            <div style="display: flex; flex-direction: column; gap: 3px;">
              <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <span style="color: #166534; font-weight: 700; font-size: 10px;">Free:</span>
                ${freeBadges}
              </div>
              <div style="font-size: 10px; color: var(--text-muted);">
                Teaching: ${busySlots.length} period${busySlots.length === 1 ? '' : 's'}
              </div>
            </div>
          </td>
        `;
      }).join('');

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11px; color: var(--text-muted);">${escapeHtml(fac.staffId || '-')}</td>
          <td><span class="badge" style="background: #e2e8f0; color: #334155; font-weight: 700;">${escapeHtml(fac.code)}</span></td>
          <td>
            <strong style="color: var(--text-main); font-size: 13px;">${escapeHtml(fac.name)}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(fac.designation)}</div>
          </td>
          <td><span class="badge badge-info" style="font-size: 11px;">${escapeHtml(fac.department)}</span></td>
          ${daysHtml}
          <td class="text-center">
            <strong style="color: #16a34a; font-size: 13px;">${fac.totalFree} hrs</strong>
            <div style="font-size: 10px; color: var(--text-muted);">/ ${fac.maxPeriods} hrs</div>
          </td>
        </tr>
      `;
    }).join('');
  }
}

function exportFreeFacultyCSV() {
  const { day, period, dept, program, sem, viewMode } = freeFacultyState.filters;
  const table = viewMode === 'roster'
    ? document.getElementById('table-free-faculty-roster')
    : document.getElementById('table-free-faculty-matrix');

  if (!table) return;

  const rows = [];
  const ths = table.querySelectorAll('thead th');
  rows.push(Array.from(ths).map(th => `"${th.textContent.replace(/[\n\r]+/g, ' ').trim()}"`).join(','));

  const trs = table.querySelectorAll('tbody tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length === 0) return;
    const rowValues = Array.from(tds).map(td => `"${td.textContent.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()}"`);
    rows.push(rowValues.join(','));
  });

  const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(rows.join("\n"));
  const link = document.createElement("a");
  const fileName = `Free_Faculty_${viewMode}_${day}_P${period}_${dept}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.setAttribute("href", csvContent);
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function printFreeFacultyRoster() {
  const { day, period, dept, program, sem, viewMode } = freeFacultyState.filters;
  const table = viewMode === 'roster'
    ? document.getElementById('table-free-faculty-roster')
    : document.getElementById('table-free-faculty-matrix');

  if (!table) return;

  const dayDisplay = day === 'ALL' ? 'All Weekdays' : day.charAt(0) + day.slice(1).toLowerCase();
  const periodDisplay = period === 'ALL' ? 'All Periods' : `Period ${period}`;
  const slotText = (day === 'ALL' && period === 'ALL')
    ? 'All Days & Periods'
    : (day === 'ALL' ? `Every Day, ${periodDisplay}` : (period === 'ALL' ? `${dayDisplay}, All Periods` : `${dayDisplay}, ${periodDisplay}`));

  const printWindow = window.open('', '_blank', 'width=1100,height=750');
  if (!printWindow) {
    window.print();
    return;
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Free Faculty Staff Room Roster - ${slotText}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 20px; color: #1e293b; }
        .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
        .header h1 { margin: 0; font-size: 20px; text-transform: uppercase; letter-spacing: 0.5px; }
        .header h2 { margin: 4px 0 0; font-size: 15px; color: #2563eb; }
        .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; background: #f8fafc; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px; }
        .meta-item strong { display: block; color: #64748b; font-size: 10px; text-transform: uppercase; margin-bottom: 2px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 20px; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
        th { background: #f1f5f9; font-weight: 700; color: #334155; }
        .text-center { text-align: center; }
        .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; }
        .footer { margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; color: #64748b; border-top: 1px solid #cbd5e1; padding-top: 10px; }
        @media print {
          @page { size: landscape; margin: 12mm; }
          body { margin: 0; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Central Faculty Timetable System</h1>
        <h2>Staff Room Availability Roster & Free Faculty Report</h2>
      </div>
      <div class="meta-grid">
        <div class="meta-item"><strong>Inspected Slot</strong><span>${escapeHtml(slotText)}</span></div>
        <div class="meta-item"><strong>Department Filter</strong><span>${escapeHtml(dept)}</span></div>
        <div class="meta-item"><strong>Program & Semester</strong><span>${escapeHtml(program)} / Sem ${escapeHtml(sem)}</span></div>
        <div class="meta-item"><strong>Generated On</strong><span>${new Date().toLocaleString()}</span></div>
      </div>
      ${table.outerHTML}
      <div class="footer">
        <span>Verified by Central Administration</span>
        <span>Faculty Scheduling System &bull; Staff Room Availability Report</span>
      </div>
      <script>
        window.onload = function() {
          window.print();
        };
      <\/script>
    </body>
    </html>
  `;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}


