// ==========================================================================
// Frontend JavaScript Controller & Department Portal Script
// ==========================================================================

const API_BASE = '/api';

async function authFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  const token = sessionStorage.getItem('token');
  if (token) {
    options.headers['Authorization'] = token;
  }
  return fetch(url, options);
}

// Application State
let state = {
  currentUser: null, // { role: 'department', departmentName: '...' }
  config: null,      // { academicYear, semesterType, semesterLabels, periods }
  departments: [],
  courses: [],       // raw list of all courses
  faculty: [],       // raw list of all faculty
  allocations: {},   // active allocations for department
  selectedDay: 'MONDAY',
  viewMode: 'day',   // 'day' or 'week'
  filters: {
    program: '',
    semester: '',
    category: ''
  },
  allBatches: [],
  groupMappings: {}
};

let autosaveTimer = null;

// Helper to format course code with clickable group badge
function formatCourseCodeWithGroup(code, group, mappedBatches = []) {
  const base = code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
  if (group && group > 0) {
    const titleText = mappedBatches && mappedBatches.length > 0
      ? `Mapped Batches:\n${mappedBatches.join('\n')}`
      : 'No batches mapped';
    return `${base} <span class="badge" title="${titleText}" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; cursor: help; border-radius: 4px;">G${group}</span>`;
  }
  return base;
}

// Get the implicitly determined batch based on program, department, semester, and funding
function getImplicitBatch(course) {
  if (!state.currentUser || !state.currentUser.departmentName || !course) return [];
  const deptName = state.currentUser.departmentName.toUpperCase();
  const programCode = course.programType === 'PG' ? 'P' : 'U';
  const fundingCode = '1'; // Default to Aided

  const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
  const deptCode = batchForDept ? batchForDept.deptCode : '';

  const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
  const year = batchForYear ? batchForYear.year : '';

  if (deptCode && year) {
    return [(programCode + fundingCode + deptCode + year).toUpperCase()];
  }
  return [];
}

// Get final batches array for a course (explicit mapping or implicit default fallback)
// If classIndex is provided (e.g. 1, 2), it resolves batches specifically for that class.
function getCourseClassBatches(course, classIndex = null) {
  if (!course) return [];
  const keyWithGroup = course.code.replace(/-(T|P)$/, '').replace(/_C\d+$/, '');
  const keyWithoutGroup = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');

  if (classIndex) {
    const list = state.groupMappings[`${keyWithoutGroup}_C${classIndex}`] || state.groupMappings[`${keyWithGroup}_C${classIndex}`] || [];
    if (list.length > 0) return list;
  } else {
    let mapped = [];
    if (course.classes && course.classes > 1) {
      for (let i = 1; i <= course.classes; i++) {
        const list = state.groupMappings[`${keyWithoutGroup}_C${i}`] || state.groupMappings[`${keyWithGroup}_C${i}`] || [];
        if (list.length > 0) {
          mapped.push(`C${i}: ${list.join('/')}`);
        }
      }
    } else {
      mapped = state.groupMappings[keyWithGroup] || state.groupMappings[keyWithoutGroup] || [];
    }
    if (mapped.length > 0) {
      return mapped;
    }
  }

  // If this is a grouped course (elective), do not fallback to implicit department batch
  if (course.group && course.group > 0) {
    return [];
  }

  return getImplicitBatch(course);
}


function isTimetableLocked() {
  if (!state.currentUser || !state.currentUser.departmentName) return false;
  const deptName = state.currentUser.departmentName;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };
  return deptInfo.status === 'Submitted' || deptInfo.status === 'Approved';
}

function applyEditLocksUI() {
  const locked = isTimetableLocked();
  const deptName = state.currentUser ? state.currentUser.departmentName : null;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };

  const btnSaveDraft = document.getElementById('btn-save-draft');
  const btnSubmit = document.getElementById('btn-submit-timetable');
  const btnRevert = document.getElementById('btn-revert-submission');
  const btnSaveAllCourses = document.getElementById('btn-save-all-courses');
  const btnSaveAllFaculty = document.getElementById('btn-save-all-faculty');
  const feedbackCard = document.getElementById('admin-feedback-card');
  const feedbackText = document.getElementById('admin-feedback-text');
  const autosaveStatus = document.getElementById('autosave-status');

  if (locked) {
    if (btnSaveDraft) btnSaveDraft.classList.add('hidden');
    if (btnSubmit) btnSubmit.classList.add('hidden');
    if (btnRevert) {
      if (deptInfo.status === 'Submitted') {
        btnRevert.classList.remove('hidden');
      } else {
        btnRevert.classList.add('hidden');
      }
    }
    if (autosaveStatus) autosaveStatus.textContent = '';
  } else {
    if (btnSaveDraft) btnSaveDraft.classList.remove('hidden');
    if (btnSubmit) btnSubmit.classList.remove('hidden');
    if (btnRevert) btnRevert.classList.add('hidden');
  }

  if (btnSaveAllCourses) btnSaveAllCourses.disabled = locked;
  if (btnSaveAllFaculty) btnSaveAllFaculty.disabled = locked;

  // Feedback Card visibility
  if (deptInfo.status === 'Returned for Changes') {
    if (feedbackCard) feedbackCard.classList.remove('hidden');
    if (feedbackText) feedbackText.textContent = deptInfo.comments || 'Please revise your timetable allocations according to admin requirements.';
  } else {
    if (feedbackCard) feedbackCard.classList.add('hidden');
  }
}

function triggerAutosave() {
  if (isTimetableLocked()) return; // block autosave if locked

  const statusEl = document.getElementById('autosave-status');
  if (statusEl) {
    statusEl.textContent = 'Draft changes pending...';
  }

  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }

  autosaveTimer = setTimeout(async () => {
    if (statusEl) {
      statusEl.textContent = 'Saving draft...';
    }
    
    const deptName = state.currentUser.departmentName;
    try {
      const saveRes = await authFetch(`${API_BASE}/allocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          allocations: state.allocations
        })
      });
      const result = await saveRes.json();
      
      if (!saveRes.ok) {
        if (statusEl) {
          statusEl.textContent = 'Autosave failed: ' + result.message;
        }
        return;
      }
      
      const timeStr = new Date().toLocaleTimeString();
      if (statusEl) {
        statusEl.textContent = `Draft autosaved at ${timeStr}`;
      }
      
      await fetchGlobalData();
      updateDeptStatusBadge();
    } catch (err) {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = 'Autosave failed: Connection error';
      }
    }
  }, 5000);
}

// Custom Modal Alerts Utility (Eliminating browser window alert/confirms)
window.appModal = {
  overlay: document.getElementById('app-modal'),
  icon: document.getElementById('app-modal-icon'),
  title: document.getElementById('app-modal-title'),
  message: document.getElementById('app-modal-message'),
  btnPrimary: document.getElementById('app-modal-btn-primary'),
  btnSecondary: document.getElementById('app-modal-btn-secondary')
};

function showModalAlert(title, message, type = 'info', callback = null) {
  const { overlay, icon, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  window.appModal.message.textContent = message;
  
  let iconHtml = '<i class="fa-solid fa-circle-info text-primary"></i>';
  if (type === 'success') iconHtml = '<i class="fa-solid fa-circle-check text-success"></i>';
  else if (type === 'warning') iconHtml = '<i class="fa-solid fa-triangle-exclamation text-warning"></i>';
  else if (type === 'danger') iconHtml = '<i class="fa-solid fa-circle-xmark text-danger"></i>';
  window.appModal.icon.innerHTML = iconHtml;
  
  btnSecondary.classList.add('hidden');
  btnPrimary.textContent = "Okay";
  
  // Clone to remove old event listeners
  const newBtn = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtn, btnPrimary);
  window.appModal.btnPrimary = newBtn;
  
  window.appModal.btnPrimary.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (callback) callback();
  });
  
  overlay.classList.remove('hidden');
}

function showModalConfirm(title, message, onConfirm) {
  const { overlay, icon, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  window.appModal.message.textContent = message;
  window.appModal.icon.innerHTML = '<i class="fa-solid fa-circle-question text-primary"></i>';
  
  btnSecondary.classList.remove('hidden');
  btnSecondary.textContent = "Cancel";
  btnPrimary.textContent = "Confirm";
  
  // Clone primary
  const newBtnPrimary = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtnPrimary, btnPrimary);
  window.appModal.btnPrimary = newBtnPrimary;
  
  // Clone secondary
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
}

// Initializer
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  bindAuthEvents();
  bindDeptEvents();
  bindFilterEvents();
  bindPrintEvents();
  bindFacultySelectEvents();
  bindAutoGeneratorEvents();
  
  // Restore session
  const savedUser = sessionStorage.getItem('currentUser');
  if (savedUser) {
    state.currentUser = JSON.parse(savedUser);
    document.getElementById('current-user-display').textContent = state.currentUser.departmentName;
    document.getElementById('header-user-info').classList.remove('hidden');
    
    await fetchGlobalData();
    switchView('department');
    await loadDepartmentWorkspace();
  } else {
    await loadLoginDepartments();
    switchView('login');
  }
}

// View toggle
function switchView(viewName) {
  const loginView = document.getElementById('view-login');
  const deptView = document.getElementById('view-department');
  
  if (viewName === 'department') {
    deptView.classList.remove('hidden');
    deptView.classList.add('active');
    loginView.classList.add('hidden');
    loginView.classList.remove('active');
  } else {
    loginView.classList.remove('hidden');
    loginView.classList.add('active');
    deptView.classList.add('hidden');
    deptView.classList.remove('active');
  }
}

async function loadLoginDepartments() {
  try {
    const res = await fetch(`${API_BASE}/departments`);
    const depts = await res.json();
    state.departments = depts;
    
    const dropdown = document.getElementById('login-dept');
    dropdown.innerHTML = '<option value="" disabled selected>Select Department</option>';
    depts.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.name;
      dropdown.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
  }
}

async function fetchGlobalData() {
  try {
    const [configRes, deptsRes, coursesRes, facultyRes, batchesRes, groupRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      authFetch(`${API_BASE}/courses`),
      authFetch(`${API_BASE}/faculty`),
      authFetch(`${API_BASE}/batches`),
      authFetch(`${API_BASE}/admin/group-mappings`)
    ]);
    
    state.config = await configRes.json();
    state.departments = await deptsRes.json();
    state.courses = await coursesRes.json();
    state.faculty = await facultyRes.json();
    state.allBatches = await batchesRes.json();
    state.groupMappings = await groupRes.json();
  } catch (err) {
    console.error(err);
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
    const departmentName = document.getElementById('login-dept').value;
    const hiddenUser = document.getElementById('hidden-dept-username');
    if (hiddenUser) hiddenUser.value = departmentName;
    const password = pwdInput.value;
    errBox.classList.add('hidden');
    
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'department', departmentName, password })
      });
      
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || 'Login failed');
      
      state.currentUser = { role: 'department', departmentName, token: result.token };
      sessionStorage.setItem('currentUser', JSON.stringify(state.currentUser));
      sessionStorage.setItem('token', result.token);
      document.getElementById('current-user-display').textContent = departmentName;
      document.getElementById('header-user-info').classList.remove('hidden');
      
      await fetchGlobalData();
      switchView('department');
      await loadDepartmentWorkspace();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('currentUser');
    sessionStorage.removeItem('token');
    state.currentUser = null;
    document.getElementById('header-user-info').classList.add('hidden');
    pwdInput.value = '';
    loadLoginDepartments();
    switchView('login');
  });
}

// -------------------------------------------------------------
// Filters & Toggles Binds
// -------------------------------------------------------------
function bindFilterEvents() {
  const progSelect = document.getElementById('filter-program');
  const semSelect = document.getElementById('filter-semester');
  const catSelect = document.getElementById('filter-category');
  
  if (progSelect) {
    progSelect.addEventListener('change', () => {
      state.filters.program = progSelect.value;
      populateFilters();
      renderAllocationMatrix();
    });
  }
  
  semSelect.addEventListener('change', () => {
    state.filters.semester = semSelect.value;
    renderAllocationMatrix();
  });
  
  catSelect.addEventListener('change', () => {
    state.filters.category = catSelect.value;
    renderAllocationMatrix();
  });

  // Dynamic filter lists population
  function populateFilters() {
    const deptName = state.currentUser.departmentName;
    let deptCourses = state.courses.filter(c => c.department === deptName);
    
    // Apply program filter to find available semesters and categories
    if (state.filters.program) {
      deptCourses = deptCourses.filter(c => (c.programType || 'UG') === state.filters.program);
    }
    
    // Semesters
    const sems = Array.from(new Set(deptCourses.map(c => c.semester))).sort();
    const prevSelectedSem = state.filters.semester;
    
    semSelect.innerHTML = '<option value="">All Semesters</option>';
    sems.forEach(s => {
      let label = state.config.semesterLabels[s] || `Sem ${s}`;
      
      // Determine what program types exist for this semester in the filtered list
      const coursePrograms = Array.from(new Set(deptCourses.filter(c => c.semester === s).map(c => c.programType || 'UG')));
      if (coursePrograms.length === 1) {
        label = getSemesterLabel(s, coursePrograms[0]);
      } else if (coursePrograms.length > 1) {
        label = `${getSemesterLabel(s, 'UG')} / ${getSemesterLabel(s, 'PG')}`;
      }
      
      semSelect.innerHTML += `<option value="${s}">${label}</option>`;
    });
    
    if (sems.includes(prevSelectedSem)) {
      semSelect.value = prevSelectedSem;
    } else {
      state.filters.semester = '';
      semSelect.value = '';
    }

    // Categories
    const cats = Array.from(new Set(deptCourses.map(c => c.category))).sort();
    const prevSelectedCat = state.filters.category;
    
    catSelect.innerHTML = '<option value="">All Categories</option>';
    cats.forEach(c => {
      catSelect.innerHTML += `<option value="${c}">${c}</option>`;
    });
    
    if (cats.includes(prevSelectedCat)) {
      catSelect.value = prevSelectedCat;
    } else {
      state.filters.category = '';
      catSelect.value = '';
    }
  }

  function getSemesterLabel(s, program) {
    const baseLabel = state.config.semesterLabels[s] || `Sem ${s}`;
    if (program === 'PG') {
      if (baseLabel.toUpperCase().includes('BSC')) {
        return baseLabel.replace(/BSC/i, 'MSC');
      }
      return `${baseLabel} MSC`;
    } else if (program === 'UG') {
      if (baseLabel.toUpperCase().includes('BSC')) {
        return baseLabel;
      }
      return `${baseLabel} BSC`;
    }
    return baseLabel;
  }

  // Hook populateFilters to trigger when loading workspace
  window.populateFiltersDropdowns = populateFilters;
}

// -------------------------------------------------------------
// Department Workspace
// -------------------------------------------------------------
async function loadDepartmentWorkspace() {
  const deptName = state.currentUser.departmentName;
  document.getElementById('dept-title-name').textContent = `Department of ${deptName}`;
  
  try {
    const res = await authFetch(`${API_BASE}/allocations?department=${deptName}`);
    state.allocations = await res.json();
    
    updateDeptStatusBadge();
    window.populateFiltersDropdowns();
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
    renderDeptDataEditors();
    applyEditLocksUI();
  } catch (err) {
    console.error(err);
  }
}

function updateDeptStatusBadge() {
  const deptName = state.currentUser.departmentName;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };
  
  const badge = document.getElementById('dept-status-badge');
  badge.textContent = deptInfo.status;
  badge.className = 'badge';
  
  if (deptInfo.status === 'Approved') badge.classList.add('badge-info');
  else if (deptInfo.status === 'Submitted') badge.classList.add('recommend-p');
  else if (deptInfo.status === 'Returned for Changes') badge.classList.add('recommend-t');
  else badge.classList.add('recommend-none');
}

function bindDeptEvents() {
  // Day tab switch
  document.querySelectorAll('.weekday-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.weekday-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.selectedDay = tab.getAttribute('data-day');
      renderAllocationMatrix();
    });
  });

  // Toggle Grid View Mode (Single Day vs Full Week)
  document.getElementById('btn-toggle-grid-mode').addEventListener('click', () => {
    const btn = document.getElementById('btn-toggle-grid-mode');
    const daySelector = document.getElementById('weekday-selector-wrapper');
    const fullWeekHeader = document.getElementById('full-week-header-label');
    
    if (state.viewMode === 'day') {
      state.viewMode = 'week';
      btn.innerHTML = '<i class="fa-solid fa-calendar-day"></i> Switch to Day View';
      daySelector.style.display = 'none';
      fullWeekHeader.style.display = 'block';
    } else {
      state.viewMode = 'day';
      btn.innerHTML = '<i class="fa-solid fa-table-cells"></i> Switch to Full Week View';
      daySelector.style.display = 'flex';
      fullWeekHeader.style.display = 'none';
    }
    renderAllocationMatrix();
  });

  // Format Excel & Import Timetable Buttons
  const btnFormatExcel = document.getElementById('btn-dept-format-excel');
  const btnImportExcel = document.getElementById('btn-dept-import-excel');
  const fileInputDept = document.getElementById('import-dept-timetable-file');
  const modalFormat = document.getElementById('modal-dept-excel-format');
  const btnCloseFormat1 = document.getElementById('btn-close-dept-excel-format');
  const btnCloseFormat2 = document.getElementById('btn-close-dept-excel-format-secondary');
  const btnDownloadTemplate = document.getElementById('btn-download-dept-template');

  function downloadDepartmentTemplate() {
    if (!state.currentUser || !state.currentUser.departmentName) return;
    const deptName = encodeURIComponent(state.currentUser.departmentName);
    const token = sessionStorage.getItem('token') || '';
    window.location.href = `${API_BASE}/department/import-template?department=${deptName}&token=${encodeURIComponent(token)}`;
  }

  if (btnFormatExcel) {
    btnFormatExcel.addEventListener('click', () => {
      if (modalFormat) modalFormat.classList.remove('hidden');
    });
  }

  if (btnCloseFormat1) {
    btnCloseFormat1.addEventListener('click', () => modalFormat.classList.add('hidden'));
  }
  if (btnCloseFormat2) {
    btnCloseFormat2.addEventListener('click', () => modalFormat.classList.add('hidden'));
  }

  if (btnDownloadTemplate) {
    btnDownloadTemplate.addEventListener('click', () => {
      downloadDepartmentTemplate();
    });
  }

  if (btnImportExcel && fileInputDept) {
    btnImportExcel.addEventListener('click', () => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert('Timetable Locked', `Your department timetable is locked because it is currently ${deptInfo.status}. Editing or importing allocations is disabled.`, 'warning');
        return;
      }
      fileInputDept.click();
    });

    fileInputDept.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);
      formData.append('departmentName', state.currentUser.departmentName);

      try {
        const res = await authFetch(`${API_BASE}/department/import-timetable`, {
          method: 'POST',
          body: formData
        });

        const result = await res.json();
        fileInputDept.value = ''; // Reset input

        if (res.ok && result.success) {
          let warnMsg = '';
          if (result.warnings && result.warnings.length > 0) {
            warnMsg = '\n\nNote:\n' + result.warnings.slice(0, 5).join('\n') + (result.warnings.length > 5 ? `\n...and ${result.warnings.length - 5} more warnings.` : '');
          }
          showModalAlert('Import Successful', result.message + warnMsg, 'success', async () => {
            await fetchGlobalData();
            await loadDepartmentWorkspace();
          });
        } else {
          let clashDetails = '';
          if (result.clashes && result.clashes.length > 0) {
            clashDetails = '\n\nClashes detected:\n' + result.clashes.map(c => `• ${c.facultyCode} double booked on ${c.weekday} P${c.period} (${c.courses.join(', ')})`).join('\n');
          }
          showModalAlert('Import Failed', (result.message || result.error || 'Failed to import timetable.') + clashDetails, 'danger');
        }
      } catch (err) {
        console.error(err);
        fileInputDept.value = '';
        showModalAlert('Error', 'Connection error while uploading timetable Excel.', 'danger');
      }
    });
  }

  // Department Sub-tabs for inline editors
  document.querySelectorAll('.tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const subId = btn.getAttribute('data-subtab');
      document.querySelectorAll('.subtab-pane').forEach(p => {
        if (p.id === subId) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
    });
  });

  // Bottom action buttons
  const saveDraftBtn = document.getElementById('btn-save-draft');
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', () => {
      saveDepartmentAllocations(false);
    });
  }
  document.getElementById('btn-submit-timetable').addEventListener('click', () => {
    saveDepartmentAllocations(true);
  });
  document.getElementById('btn-preview-timetable').addEventListener('click', () => {
    openTimetablePrintPreview(state.currentUser.departmentName);
  });
  
  const btnRevert = document.getElementById('btn-revert-submission');
  if (btnRevert) {
    btnRevert.addEventListener('click', () => {
      const deptName = state.currentUser.departmentName;
      showModalConfirm(
        'Revert Submission?',
        'Are you sure you want to revert your submission back to Draft? This will allow you to edit your timetable allocations again.',
        async () => {
          try {
            const res = await authFetch(`${API_BASE}/submissions/status`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                departmentName: deptName,
                status: 'Draft',
                comments: 'Reverted to Draft by department coordinator.'
              })
            });
            if (res.ok) {
              showModalAlert('Success', 'Submission reverted to Draft. You can now edit the timetable.', 'success');
              await fetchGlobalData();
              await loadDepartmentWorkspace();
            } else {
              const err = await res.json();
              showModalAlert('Error', err.message || 'Failed to revert submission.', 'danger');
            }
          } catch (err) {
            console.error(err);
            showModalAlert('Error', 'Connection error while reverting submission.', 'danger');
          }
        }
      );
    });
  }

  // Department Group & Batch Assignment Modal Events
  const modalDeptMapping = document.getElementById('modal-dept-group-mapping');
  const btnCloseDeptMapping = document.getElementById('btn-close-dept-group-mapping-modal');
  const btnSaveDeptMapping = document.getElementById('btn-save-dept-group-mapping');
  const deptGroupCountSelect = document.getElementById('dept-group-count-select');

  if (btnCloseDeptMapping) {
    btnCloseDeptMapping.addEventListener('click', () => {
      modalDeptMapping.classList.add('hidden');
    });
  }

  if (deptGroupCountSelect) {
    deptGroupCountSelect.addEventListener('change', () => {
      const courseCode = document.getElementById('dept-mapping-course-code').value;
      const course = state.courses.find(c => c.code === courseCode);
      if (!course) return;

      const deptName = state.currentUser.departmentName.toUpperCase();
      const programCode = course.programType === 'PG' ? 'P' : 'U';
      const fundingCode = '1';

      const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
      const deptCode = batchForDept ? batchForDept.deptCode : '';

      const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
      const year = batchForYear ? batchForYear.year : '';

      const defaultBatchId = (programCode + fundingCode + deptCode + year).toUpperCase();

      renderDeptGroupSelects(course, defaultBatchId);
    });
  }

  if (btnSaveDeptMapping) {
    btnSaveDeptMapping.addEventListener('click', async () => {
      const courseCode = document.getElementById('dept-mapping-course-code').value;
      const countVal = parseInt(deptGroupCountSelect.value) || 1;
      
      const selects = document.querySelectorAll('.dept-group-select-item');
      const selectedBatches = Array.from(selects).map(s => s.value);

      try {
        const res = await authFetch(`${API_BASE}/courses/class-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseCode,
            classes: countVal,
            batches: selectedBatches,
            departmentName: state.currentUser.departmentName
          })
        });

        if (res.ok) {
          modalDeptMapping.classList.add('hidden');
          showModalAlert('Success', 'Class configurations and batch mappings updated successfully!', 'success');
          await fetchGlobalData();
          await loadDepartmentWorkspace();
        } else {
          const err = await res.json();
          showModalAlert('Error', err.message || 'Failed to save changes.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Connection error while saving mappings.', 'danger');
      }
    });
  }



  // Save All buttons
  document.getElementById('btn-save-all-courses').addEventListener('click', async () => {
    const deptName = state.currentUser.departmentName;
    const deptCourses = state.courses.filter(c => c.department === deptName);
    const coursesToSave = deptCourses.map(c => {
      const alias = document.getElementById(`calias-${c.code}`).value.trim();
      return { code: c.code, name: c.name, alias };
    });

    try {
      const res = await authFetch(`${API_BASE}/courses/alias/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses: coursesToSave, departmentName: deptName })
      });
      if (res.ok) {
        showModalAlert('Success', 'All course details updated successfully!', 'success');
        await fetchGlobalData();
        renderAllocationMatrix();
        renderDeptDataEditors();
      } else {
        const err = await res.json();
        showModalAlert('Error', err.message || 'Failed to update courses.', 'danger');
        renderDeptDataEditors();
      }
    } catch (err) {
      console.error(err);
      showModalAlert('Error', 'Failed to communicate with server.', 'danger');
      renderDeptDataEditors();
    }
  });

  document.getElementById('btn-save-all-faculty').addEventListener('click', async () => {
    const deptName = state.currentUser.departmentName;
    const deptFaculty = state.faculty.filter(f => f.department === deptName);
    const facultyToSave = deptFaculty.map(f => {
      const code = document.getElementById(`fcode-${f.staffId}`).value.trim();
      return { staffId: f.staffId, code };
    });

    try {
      const res = await authFetch(`${API_BASE}/faculty/code/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faculty: facultyToSave, departmentName: deptName })
      });
      if (res.ok) {
        showModalAlert('Success', 'All faculty initials codes updated successfully!', 'success');
        await fetchGlobalData();
        await loadDepartmentWorkspace();
      } else {
        const err = await res.json();
        let explanation = err.message || 'Failed to update faculty codes.';
        if (explanation.includes('already assigned')) {
          explanation += '\n\nNote: Faculty visual initials codes must be unique across the entire college to prevent scheduling overlaps and distinguish between faculty members during allocation.';
        }
        showModalAlert('Conflict Error', explanation, 'danger');
        renderDeptDataEditors();
      }
    } catch (err) {
      console.error(err);
      showModalAlert('Error', 'Failed to communicate with server.', 'danger');
      renderDeptDataEditors();
    }
  });
}


// Dynamic Row Merge Layout & Matrix Compiler
function renderAllocationMatrix() {
  const deptName = state.currentUser.departmentName;
  const periods = state.config.periods;
  const table = document.getElementById('table-allocation-matrix');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  // Clean table styling
  table.className = 'table table-grid';
  
  // Filter courses for this department
  let deptCourses = state.courses.filter(c => c.department === deptName);
  
  // Apply Dropdown Filters
  if (state.filters.program) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === state.filters.program);
  }
  if (state.filters.semester) {
    deptCourses = deptCourses.filter(c => c.semester === state.filters.semester);
  }
  if (state.filters.category) {
    deptCourses = deptCourses.filter(c => c.category === state.filters.category);
  }

  // Merge theory (-T) and practical (-P) courses sharing same base code into unique list
  const baseCourseCodes = Array.from(new Set(deptCourses.map(c => c.code.replace(/-(T|P)$/, '')))).sort();

  // -----------------------------------------------------------
  // CASE A: FULL WEEK VIEW (30 period columns)
  // -----------------------------------------------------------
  if (state.viewMode === 'week') {
    table.classList.add('full-week-mode');
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    const weekdaysShort = ["MON", "TUE", "WED", "THU", "FRI"];
    
    // Build headers double row
    let headerRow1 = `<tr><th rowspan="2" style="min-width:110px; text-align:left;">Course Code</th><th rowspan="2" style="min-width:160px; text-align:left;">Course Name / Alias</th>`;
    let headerRow2 = `<tr>`;
    
    weekdays.forEach((day, dIdx) => {
      // Calculate period count to set colspan
      headerRow1 += `<th colspan="${periods.length}" style="border-bottom:2px solid var(--primary);">${weekdaysShort[dIdx]}</th>`;
      periods.forEach(p => {
        headerRow2 += `<th>${p}</th>`;
      });
    });
    headerRow1 += `</tr>`;
    headerRow2 += `</tr>`;
    thead.innerHTML = headerRow1 + headerRow2;

    tbody.innerHTML = '';
    if (baseCourseCodes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${5 * periods.length + 2}" class="text-center text-muted">No courses found matching active filters.</td></tr>`;
      return;
    }

    baseCourseCodes.forEach(baseCode => {
      const { courseT, courseP, dispName, dispAlias, sem, cat, group, mappedBatches, classes } = getMergedCourseInfo(baseCode, deptCourses);
      
      const count = classes > 1 ? classes : 1;
      for (let cl = 1; cl <= count; cl++) {
        const isCloned = classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const rowBatchesWeek = getCourseClassBatches(activeCourseRef, isCloned ? cl : null);
        const classBadgeTooltip = isCloned
          ? (rowBatchesWeek.length > 0 ? `Batch: ${rowBatchesWeek.join(', ')}` : 'No batch mapped')
          : '';
        const formattedCode = isCloned
          ? `${baseCode} <span class="badge" title="${classBadgeTooltip}" style="background-color: var(--primary); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px; cursor: help;">Class ${cl}</span>`
          : formatCourseCodeWithGroup(baseCode, group, rowBatchesWeek);
        const rowAlias = isCloned ? `${dispAlias} (C${cl})` : dispAlias;
        
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">${formattedCode}</td>
          <td style="text-align:left;" title="${dispName}">
            <span class="badge badge-info">${rowAlias}</span>
          </td>
        `;

        // Render cells sequentially for MON-FRI and P1-P6
        weekdays.forEach(day => {
          periods.forEach(p => {
            const td = document.createElement('td');
            if (p.toUpperCase() === 'LB') {
              td.className = 'slot-lb';
              td.textContent = 'LB';
              tr.appendChild(td);
              return;
            }

            const cellHtml = renderCellSlot(baseCode, courseT, courseP, day, p, isCloned ? cl : null);
            td.className = cellHtml.classes;
            td.innerHTML = cellHtml.html;
            tr.appendChild(td);
          });
        });

        tbody.appendChild(tr);
      }
    });

  // -----------------------------------------------------------
  // CASE B: SINGLE DAY VIEW
  // -----------------------------------------------------------
  } else {
    // 1. Build Header
    let headerHtml = `
      <tr>
        <th style="min-width:120px; text-align:left;">Course Code</th>
        <th style="min-width:180px; text-align:left;">Course Name / Alias</th>
        <th style="width:70px;">Sem.</th>
        <th style="width:80px;">Category</th>
        <th style="min-width:120px; text-align:left;">Batches</th>
    `;
    periods.forEach(p => {
      headerHtml += `<th style="width:120px;">${p}</th>`;
    });
    headerHtml += `</tr>`;
    thead.innerHTML = headerHtml;

    tbody.innerHTML = '';
    if (baseCourseCodes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${periods.length + 5}" class="text-center text-muted">No courses found matching active filters.</td></tr>`;
      return;
    }

    baseCourseCodes.forEach(baseCode => {
      const { courseT, courseP, dispName, dispAlias, sem, cat, group, mappedBatches, classes } = getMergedCourseInfo(baseCode, deptCourses);
      
      const count = classes > 1 ? classes : 1;
      for (let cl = 1; cl <= count; cl++) {
        const isCloned = classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const rowBatches = getCourseClassBatches(activeCourseRef, isCloned ? cl : null);
        const formattedCode = isCloned
          ? `${baseCode} <span class="badge" style="background-color: var(--primary); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px;">Class ${cl}</span>`
          : formatCourseCodeWithGroup(baseCode, group, rowBatches);
        const rowAlias = isCloned ? `${dispAlias} (C${cl})` : dispAlias;
          
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">${formattedCode}</td>
          <td style="text-align:left;">
            <span class="badge badge-info">${rowAlias}</span>
            <div class="text-sm bold text-muted">${dispName}</div>
          </td>
          <td>${sem}</td>
          <td>${cat}</td>
          <td style="text-align:left;">
            ${rowBatches.length > 0
              ? rowBatches.map(b => `<span class="badge badge-info" style="margin:2px; font-size:11px;">${b}</span>`).join('')
              : '<span class="text-muted text-sm">-</span>'}
          </td>
        `;

        periods.forEach(p => {
          const td = document.createElement('td');
          if (p.toUpperCase() === 'LB') {
            td.className = 'slot-lb';
            td.textContent = 'LB';
            tr.appendChild(td);
            return;
          }

          const cellHtml = renderCellSlot(baseCode, courseT, courseP, state.selectedDay, p, isCloned ? cl : null);
          td.className = cellHtml.classes;
          td.innerHTML = cellHtml.html;
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      }
    });
  }
}

// Merges data representation of -T and -P suffixes
function getMergedCourseInfo(baseCode, deptCourses) {
  let courseT = deptCourses.find(c => c.code === `${baseCode}-T`);
  let courseP = deptCourses.find(c => c.code === `${baseCode}-P`);
  
  if (!courseT && !courseP) {
    const fallbackCourse = deptCourses.find(c => c.code === baseCode);
    if (fallbackCourse) {
      courseT = fallbackCourse;
    }
  }
  
  const activeCourse = courseT || courseP || { name: baseCode, alias: baseCode, semester: '-', category: '-', group: 0, mappedBatches: [], classes: 1 };
  
  return {
    courseT,
    courseP,
    dispName: activeCourse.name.replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, ''),
    dispAlias: (activeCourse.alias || baseCode).replace(/-(T|P)$/, ''),
    sem: activeCourse.semester,
    cat: activeCourse.category,
    group: activeCourse.group || 0,
    mappedBatches: activeCourse.mappedBatches || [],
    classes: activeCourse.classes || 1
  };
}


// Renders the interactive contents of a grid cell
function renderCellSlot(baseCode, courseT, courseP, day, period, classIndex = null) {
  // Check if period is locked college-wide by Admin
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const globalLock = globalLocks.find(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === String(period));
  if (globalLock) {
    const lockLabel = globalLock.label || 'College Common Hour';
    const classes = 'slot-global-locked';
    const html = `
      <div class="cell-slot" title="Locked College-Wide by Admin: ${lockLabel}">
        <div class="cell-info text-sm bold" style="color: #991b1b;"><i class="fa-solid fa-lock"></i> Locked</div>
        <div class="text-sm bold" style="font-size: 11px; max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #7f1d1d;">${lockLabel}</div>
      </div>
    `;
    return { classes, html };
  }

  const recT = (courseT && courseT.recommendations[day] && courseT.recommendations[day][period]) || '';
  const recP = (courseP && courseP.recommendations[day] && courseP.recommendations[day][period]) || '';
  
  const isM = (courseT && courseT.courseType === 'M') || (courseP && courseP.courseType === 'M');
  
  let highlightClass = 'slot-recommend-none';
  let slotLabel = '';
  
  // Calculate keys for lookup based on class index if provided
  let courseTCode = courseT ? courseT.code : '';
  let coursePCode = courseP ? courseP.code : '';
  if (classIndex) {
    courseTCode = courseT ? `${baseCode}_C${classIndex}-T` : '';
    coursePCode = courseP ? `${baseCode}_C${classIndex}-P` : '';
  }
  
  let activeCourseCode = courseTCode || coursePCode;

  if (isM) {
    highlightClass = 'slot-recommend-m';
    slotLabel = '';
  } else if (recT === 'T') {
    highlightClass = 'slot-recommend-t';
    slotLabel = 'Theory Rec';
    activeCourseCode = courseTCode;
  } else if (recP === 'P') {
    highlightClass = 'slot-recommend-p';
    slotLabel = 'Practical Rec';
    activeCourseCode = coursePCode;
  } else if (recT === 'P') {
    highlightClass = 'slot-recommend-p';
    slotLabel = 'Practical Rec';
    activeCourseCode = courseTCode;
  } else if (recP === 'T') {
    highlightClass = 'slot-recommend-t';
    slotLabel = 'Theory Rec';
    activeCourseCode = coursePCode;
  } else {
    activeCourseCode = courseTCode || coursePCode;
  }

  // Load active assigned codes for this slot (merging allocations from both suffixes if any)
  const assignedT = (courseTCode && state.allocations[courseTCode] && state.allocations[courseTCode][day] && state.allocations[courseTCode][day][period]) || [];
  const assignedP = (coursePCode && state.allocations[coursePCode] && state.allocations[coursePCode][day] && state.allocations[coursePCode][day][period]) || [];
  const mergedAssigned = Array.from(new Set([...assignedT, ...assignedP]));

  // Render assigned pills with dark red crosses and tooltips
  let pillsHtml = '';
  const locked = isTimetableLocked();
  mergedAssigned.forEach(facCode => {
    const facObj = state.faculty.find(f => f.code === facCode);
    const fullName = facObj ? facObj.name : facCode;
    
    let targetCode = activeCourseCode;
    if (courseTCode && assignedT.includes(facCode)) targetCode = courseTCode;
    else if (coursePCode && assignedP.includes(facCode)) targetCode = coursePCode;

    const crossIcon = locked ? '' : `<i class="fa-solid fa-xmark" onclick="event.stopPropagation(); unassignFaculty('${targetCode}', '${day}', '${period}', '${facCode}')"></i>`;

    pillsHtml += `
      <span class="fac-pill" title="Faculty Name: ${fullName}">
        ${facCode}
        ${crossIcon}
      </span>
    `;
  });

  let classes = `slot-interactive ${highlightClass}`;
  if (mergedAssigned.length > 0) {
    classes += ' slot-has-assignments';
  }
  
  const html = `
    <div class="cell-slot" onclick="activateSlot(this, '${baseCode}', '${activeCourseCode}', '${day}', '${period}')">
      <div class="cell-info text-sm bold text-muted">${slotLabel}</div>
      <div class="cell-assigned-box">
        ${pillsHtml}
      </div>
    </div>
  `;

  return { classes, html };
}

window.activateSlot = function(cellContainer, baseCode, activeCourseCode, day, period) {
  if (isTimetableLocked()) {
    const deptName = state.currentUser ? state.currentUser.departmentName : '';
    const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
    showModalAlert(
      'Timetable Locked',
      `Your timetable is currently ${deptInfo.status}. You cannot make any changes to allocations unless you revert the submission or ask the Admin to unlock it.`,
      'info'
    );
    return;
  }

  // Check if period is locked college-wide
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const globalLock = globalLocks.find(l => l.day.toUpperCase() === day.toUpperCase() && String(l.period) === String(period));
  if (globalLock) {
    showModalAlert(
      'College-Wide Locked Period',
      `This period (${day} Period ${period}) is locked institution-wide by Central Admin for: "${globalLock.label || 'Common College Activity'}". No classes can be scheduled here.`,
      'warning'
    );
    return;
  }

  const cell = cellContainer.closest('td');
  
  const openSelector = () => {
    cell.classList.add('slot-active');
    openFacultySelectModal(baseCode, activeCourseCode, day, period, cell);
  };

  if (cell.classList.contains('slot-recommend-none')) {
    if (!cell.classList.contains('slot-active')) {
      showModalConfirm(
        'Unlock Slot?', 
        'This is a non-recommended timetable slot. Are you sure you want to unlock it for allocation?', 
        () => {
          openSelector();
        }
      );
      return;
    }
  }
  openSelector();
};

// Global active slot context
let activeSlotContext = null;

window.openFacultySelectModal = function(baseCode, courseCode, day, period, cellElement) {
  activeSlotContext = { baseCode, courseCode, day, period, cell: cellElement };
  
  const course = state.courses.find(c => c.code === courseCode);
  const group = course ? course.group : 0;
  const mappedBatches = course ? course.mappedBatches : [];
  const formattedCode = formatCourseCodeWithGroup(baseCode, group, mappedBatches);
  
  // Set details text
  const typeText = courseCode.endsWith('-P') ? 'Practical' : 'Theory';
  document.getElementById('fac-select-details').innerHTML = 
    `Course: ${formattedCode} (${typeText}) | Day: ${day} | Period: ${period}`;
  
  // Reset search input
  const searchInput = document.getElementById('fac-search-input');
  searchInput.value = '';
  
  // Populate the list
  renderFacultySelectList();
  
  // Show modal
  document.getElementById('modal-faculty-select').classList.remove('hidden');
};

function renderFacultySelectList() {
  if (!activeSlotContext) return;
  const { courseCode, day, period } = activeSlotContext;
  
  const tbody = document.querySelector('#table-fac-select-list tbody');
  tbody.innerHTML = '';
  
  const deptName = state.currentUser.departmentName;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  
  // Get active assignments
  const baseCode = courseCode.replace(/-(T|P)$/, '');
  const courseTCode = `${baseCode}-T`;
  const coursePCode = `${baseCode}-P`;
  
  const assignedT = (state.allocations[courseTCode] && state.allocations[courseTCode][day] && state.allocations[courseTCode][day][period]) || [];
  const assignedP = (state.allocations[coursePCode] && state.allocations[coursePCode][day] && state.allocations[coursePCode][day][period]) || [];
  const mergedAssigned = Array.from(new Set([...assignedT, ...assignedP]));
  
  deptFaculty.forEach(f => {
    const isAssigned = mergedAssigned.includes(f.code);
    const tr = document.createElement('tr');
    
    // Check which actual course holds this allocation (T or P)
    let assignedCourseCode = courseCode;
    if (isAssigned) {
      if (assignedT.includes(f.code)) assignedCourseCode = courseTCode;
      else if (assignedP.includes(f.code)) assignedCourseCode = coursePCode;
    }
    
    tr.innerHTML = `
      <td style="text-align: center;"><span class="fac-pill">${f.code}</span></td>
      <td><strong>${f.name}</strong></td>
      <td style="text-align: center;">
        ${isAssigned ? 
          `<button class="btn btn-outline btn-xs btn-danger" onclick="unassignFacultyFromModal('${assignedCourseCode}', '${f.code}')"><i class="fa-solid fa-user-minus"></i> Remove</button>` : 
          `<button class="btn btn-primary btn-xs" onclick="assignFacultyFromModal('${courseCode}', '${f.code}')"><i class="fa-solid fa-user-plus"></i> Assign</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.assignFacultyFromModal = async function(courseCode, facultyCode) {
  if (!activeSlotContext) return;
  const { day, period } = activeSlotContext;
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/allocations/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        courseCode,
        weekday: day,
        period,
        facultyCodes: [facultyCode]
      })
    });
    const validation = await res.json();
    
    if (!validation.valid) {
      const conf = validation.conflicts[0];
      const clashingCourse = state.courses.find(c => c.code === conf.clashingCourseCode);
      const clashingGroupSuffix = (clashingCourse && clashingCourse.group > 0) ? ` (Group ${clashingCourse.group})` : '';
      showModalAlert(
        'Hard Booking Clash!', 
        `Double-booking violation!\n\nFaculty member '${conf.facultyName}' (${conf.facultyCode}) is already allocated to '${conf.clashingCourseName}' (${conf.clashingCourseCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '')}${clashingGroupSuffix}) on ${day} Period ${period} in department ${conf.department}.`,
        'danger'
      );
      return;
    }
    
    // Save locally
    if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
    if (!state.allocations[courseCode][day]) state.allocations[courseCode][day] = {};
    if (!state.allocations[courseCode][day][period]) state.allocations[courseCode][day][period] = [];
    
    state.allocations[courseCode][day][period].push(facultyCode);
    
    // Close faculty selector modal first
    document.getElementById('modal-faculty-select').classList.add('hidden');
    
    // Auto-fill triggers — resolve base course for recommendations (handles _C1/_C2 suffixed codes)
    const baseCodeForRec = courseCode.replace(/_C\d+/, '');
    const course = state.courses.find(c => c.code === courseCode) 
               || state.courses.find(c => c.code === baseCodeForRec);
    const recType = (course && course.recommendations[day] && course.recommendations[day][period]) || '';
    if (recType === 'T' || recType === 'P') {
      showAutoFillPrompt(courseCode, recType, facultyCode);
    } else {
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      activeSlotContext = null;
      triggerAutosave();
    }
  } catch (err) {
    console.error(err);
  }
};

window.unassignFacultyFromModal = function(courseCode, facultyCode) {
  if (!activeSlotContext) return;
  const { day, period } = activeSlotContext;
  
  if (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) {
    state.allocations[courseCode][day][period] = state.allocations[courseCode][day][period].filter(code => code !== facultyCode);
    renderFacultySelectList(); // refresh list in modal
    renderAllocationMatrix(); // refresh grid
    updateDeptLiveWorkloadTracker(); // refresh workload
    triggerAutosave();
  }
};

window.unassignFaculty = function(courseCode, day, period, facultyCode) {
  if (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) {
    state.allocations[courseCode][day][period] = state.allocations[courseCode][day][period].filter(code => code !== facultyCode);
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
    triggerAutosave();
  }
};

// Auto fill logic
let autoFillContext = null;
function showAutoFillPrompt(courseCode, type, facultyCode) {
  autoFillContext = { courseCode, type, facultyCode };
  const typeText = type === 'T' ? 'theory' : 'practical';
  document.getElementById('autofill-slot-type').textContent = typeText;
  document.getElementById('dialog-autofill').classList.remove('hidden');
}

document.getElementById('btn-autofill-all').addEventListener('click', () => {
  if (autoFillContext) {
    const { courseCode, type, facultyCode } = autoFillContext;
    // Resolve base course for recommendations (handles _C1/_C2 class-suffixed codes)
    const baseCodeForRec = courseCode.replace(/_C\d+/, '');
    const course = state.courses.find(c => c.code === courseCode)
               || state.courses.find(c => c.code === baseCodeForRec);
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    
    if (course) {
      weekdays.forEach(d => {
        const recs = course.recommendations[d] || {};
        Object.keys(recs).forEach(p => {
          if (recs[p] === type) {
            const hasClash = checkLocalClash(facultyCode, d, p, courseCode);
            if (!hasClash) {
              if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
              if (!state.allocations[courseCode][d]) state.allocations[courseCode][d] = {};
              if (!state.allocations[courseCode][d][p]) state.allocations[courseCode][d][p] = [];
              
              if (!state.allocations[courseCode][d][p].includes(facultyCode)) {
                state.allocations[courseCode][d][p].push(facultyCode);
              }
            }
          }
        });
      });
    }
  }
  closeAutoFill();
});

document.getElementById('btn-autofill-single').addEventListener('click', () => {
  closeAutoFill();
});

function closeAutoFill() {
  document.getElementById('dialog-autofill').classList.add('hidden');
  autoFillContext = null;
  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  triggerAutosave();
}

function checkLocalClash(facultyCode, day, period, excludeCourseCode) {
  for (const courseCode of Object.keys(state.allocations)) {
    if (courseCode === excludeCourseCode) continue;
    const days = state.allocations[courseCode];
    if (days[day] && days[day][period] && days[day][period].includes(facultyCode)) {
      return true;
    }
  }
  return false;
}

// Live Workload count
function updateDeptLiveWorkloadTracker() {
  const deptName = state.currentUser.departmentName;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const container = document.getElementById('dept-live-workload');
  container.innerHTML = '';

  deptFaculty.forEach(f => {
    let hours = 0;
    Object.keys(state.allocations).forEach(courseCode => {
      const days = state.allocations[courseCode];
      Object.keys(days).forEach(day => {
        Object.keys(days[day]).forEach(p => {
          if (days[day][p] && days[day][p].includes(f.code)) hours++;
        });
      });
    });

    container.innerHTML += `
      <div class="workload-pill">
        <span class="fac-code">${f.code}</span>
        <span class="fac-hours">${hours} hrs</span>
      </div>
    `;
  });
}

// Save or submit allocations
async function saveDepartmentAllocations(isSubmission = false) {
  const deptName = state.currentUser.departmentName;
  
  if (isSubmission) {
    // Missing allocations warnings check
    const missing = [];
    const deptCourses = state.courses.filter(c => c.department === deptName);
    
    deptCourses.forEach(course => {
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
      weekdays.forEach(day => {
        const recs = course.recommendations[day] || {};
        Object.keys(recs).forEach(p => {
          const alloc = (state.allocations[course.code] && state.allocations[course.code][day] && state.allocations[course.code][day][p]) || [];
          if (alloc.length === 0) {
            const cleanCode = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
            const groupText = course.group > 0 ? ` (Group ${course.group})` : '';
            const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
            missing.push(`${cleanCode}${groupText} alias '${alias}' requires allocation on ${day} Period ${p}`);
          }
        });
      });
    });

    if (missing.length > 0) {
      showModalConfirm(
        'Missing Recommended Slots', 
        `Some recommended slots are missing allocations:\n\n${missing.slice(0, 4).join('\n')}\n${missing.length > 4 ? '... and ' + (missing.length - 4) + ' more' : ''}\n\nDo you want to proceed with submission?`,
        () => executeSave(isSubmission)
      );
      return;
    }
  }

  executeSave(isSubmission);
}

async function executeSave(isSubmission) {
  const deptName = state.currentUser.departmentName;
  try {
    const saveRes = await authFetch(`${API_BASE}/allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        allocations: state.allocations
      })
    });
    const result = await saveRes.json();
    
    if (!saveRes.ok) {
      showModalAlert('Clash Error', 'Save aborted: ' + result.message, 'danger');
      return;
    }

    if (isSubmission) {
      const subRes = await authFetch(`${API_BASE}/submissions/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          status: 'Submitted',
          comments: 'Timetable submitted by department coordinator.'
        })
      });
      if (subRes.ok) {
        showModalAlert('Timetable Submitted', 'Your timetable schedule has been submitted for Admin approval.', 'success');
        await loadDepartmentWorkspace();
      }
    } else {
      showModalAlert('Draft Saved', 'Your draft changes have been successfully saved on the server.', 'success');
    }
  } catch (err) {
    console.error(err);
  }
}

// -------------------------------------------------------------
// Inline Editors (Shuffled from Admin Panel to Department View)
// -------------------------------------------------------------
function renderDeptDataEditors() {
  const deptName = state.currentUser.departmentName;
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const locked = isTimetableLocked();

  document.getElementById('count-dept-courses').textContent = deptCourses.length;
  document.getElementById('count-dept-faculty').textContent = deptFaculty.length;

  // Render Courses Edit list
  const coursesTbody = document.querySelector('#table-dept-courses tbody');
  coursesTbody.innerHTML = '';
  deptCourses.forEach(c => {
    const mapped = getCourseClassBatches(c);
    const batchListHtml = mapped.length > 0 
      ? mapped.map(b => `<span class="badge badge-info" style="font-size: 11px; margin-right: 4px;">${b}</span>`).join('')
      : `<span class="text-muted text-sm">None</span>`;

    const tr = document.createElement('tr');
    // For tooltip and visual code formatting, fetch appropriate batches list
    const mappedBaseBatches = getCourseClassBatches(c);
    const formattedCode = formatCourseCodeWithGroup(c.code, c.group, mappedBaseBatches);
    tr.innerHTML = `
      <td><strong>${formattedCode}</strong></td>
      <td>${c.semester}</td>
      <td>${c.category}</td>
      <td>
        <span class="text-sm font-medium">${c.name}</span>
      </td>
      <td>
        <input type="text" class="form-control text-sm" id="calias-${c.code}" value="${c.alias || ''}" ${locked ? 'disabled' : ''}>
      </td>
      <td>
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; max-width: 250px;">
          <div style="display:flex; flex-wrap:wrap; gap:4px; flex:1;">${batchListHtml}</div>
          ${String(c.semester) === '5' ? `
            <button class="btn btn-outline btn-xs" style="padding: 2px 6px; font-size:10px; margin-left: auto;" onclick="openDeptBatchMappingModal('${c.code}')" ${locked ? 'disabled' : ''}>
              <i class="fa-solid fa-edit"></i> Map
            </button>
          ` : ''}
        </div>
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveDeptCourseRecord('${c.code}')" ${locked ? 'disabled' : ''}><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    coursesTbody.appendChild(tr);
  });

  // Render Faculty Edit list
  const facultyTbody = document.querySelector('#table-dept-faculty tbody');
  facultyTbody.innerHTML = '';
  deptFaculty.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${f.staffId}</td>
      <td><strong>${f.name}</strong></td>
      <td>
        <input type="text" class="form-control text-sm" id="fcode-${f.staffId}" value="${f.code}" style="max-width:120px;" ${locked ? 'disabled' : ''}>
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveDeptFacultyCode('${f.staffId}')" ${locked ? 'disabled' : ''}><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    facultyTbody.appendChild(tr);
  });

  // Setup click warning handler on details tab when locked
  const tableCourses = document.getElementById('table-dept-courses');
  if (tableCourses) {
    tableCourses.onclick = (e) => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert(
          'Timetable Locked',
          `Your timetable is currently ${deptInfo.status}. You cannot edit course aliases or map batches unless you revert the submission or ask the Admin to unlock it.`,
          'info'
        );
      }
    };
  }
  const tableFaculty = document.getElementById('table-dept-faculty');
  if (tableFaculty) {
    tableFaculty.onclick = (e) => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert(
          'Timetable Locked',
          `Your timetable is currently ${deptInfo.status}. You cannot edit faculty visual initials codes unless you revert the submission or ask the Admin to unlock it.`,
          'info'
        );
      }
    };
  }
}

window.saveDeptCourseRecord = async function(code) {
  const alias = document.getElementById(`calias-${code}`).value.trim();
  const course = state.courses.find(c => c.code === code);
  const name = course ? course.name : '';
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/courses/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, alias, departmentName: deptName })
    });
    if (res.ok) {
      showModalAlert('Success', 'Course details updated successfully!', 'success');
      await fetchGlobalData();
      renderAllocationMatrix();
      renderDeptDataEditors();
    } else {
      const err = await res.json();
      showModalAlert('Error', err.message, 'danger');
      renderDeptDataEditors();
    }
  } catch (err) {
    console.error(err);
    renderDeptDataEditors();
  }
};

window.saveDeptFacultyCode = async function(staffId) {
  const code = document.getElementById(`fcode-${staffId}`).value.trim();
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/faculty/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, code, departmentName: deptName })
    });
    if (res.ok) {
      showModalAlert('Success', 'Faculty initials code updated.', 'success');
      await fetchGlobalData();
      await loadDepartmentWorkspace();
    } else {
      const err = await res.json();
      let explanation = err.message || 'Faculty code update failed.';
      if (explanation.includes('already assigned')) {
        explanation += '\n\nNote: Faculty visual initials codes must be unique across the entire college to prevent scheduling overlaps and distinguish between faculty members during allocation.';
      }
      showModalAlert('Conflict Error', explanation, 'danger');
      renderDeptDataEditors();
    }
  } catch (err) {
    console.error(err);
    renderDeptDataEditors();
  }
};

// -------------------------------------------------------------
// Print Preview timetime modal
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

function bindFacultySelectEvents() {
  const modal = document.getElementById('modal-faculty-select');
  const btnClose = document.getElementById('btn-close-fac-select');
  const searchInput = document.getElementById('fac-search-input');
  
  btnClose.addEventListener('click', () => {
    modal.classList.add('hidden');
    if (activeSlotContext && activeSlotContext.cell) {
      activeSlotContext.cell.closest('td').classList.remove('slot-active');
    }
    activeSlotContext = null;
  });
  
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = document.querySelectorAll('#table-fac-select-list tbody tr');
    rows.forEach(row => {
      const text = row.innerText.toLowerCase();
      row.style.display = text.includes(query) ? '' : 'none';
    });
  });
}


function openTimetablePrintPreview(deptName) {
  activePrintDept = deptName;
  document.getElementById('print-dept-name').textContent = `DEPARTMENT OF ${deptName}`;
  document.getElementById('print-active-sem').textContent = `${state.config.semesterType} SEMESTER`;
  document.getElementById('print-active-year').textContent = state.config.academicYear;
  
  buildPrintTimetableHtml('medium');
  document.getElementById('modal-print-preview').classList.remove('hidden');
}

function buildPrintTimetableHtml(displayMode) {
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

  const deptCourses = state.courses.filter(c => c.department === activePrintDept);
  renderPrintGridRows(deptCourses, state.allocations, periods, displayMode, tbody);
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
// Department Group & Batch Assignment Modal Helpers
// -------------------------------------------------------------
window.openDeptBatchMappingModal = function(courseCode) {
  const course = state.courses.find(c => c.code === courseCode);
  if (!course) return;

  document.getElementById('dept-mapping-course-code').value = courseCode;
  document.getElementById('dept-mapping-course-title').textContent = `${course.code} - ${course.name}`;
  document.getElementById('dept-mapping-course-meta').textContent = `Semester: ${course.semester} | Category: ${course.category}`;
  
  const currentCount = course.classes || 1;

  const countSelect = document.getElementById('dept-group-count-select');
  countSelect.value = String(currentCount);

  // Populate datalist options with all batches
  const datalist = document.getElementById('dept-batch-datalist');
  if (datalist) {
    datalist.innerHTML = '';
    state.allBatches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.batchId;
      opt.textContent = `${b.batchId} - ${b.batchLabel}`;
      datalist.appendChild(opt);
    });
  }

  // Calculate default batch ID
  const deptName = state.currentUser.departmentName.toUpperCase();
  const programCode = course.programType === 'PG' ? 'P' : 'U';
  const fundingCode = '1'; // Aided only

  const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
  const deptCode = batchForDept ? batchForDept.deptCode : '';

  const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
  const year = batchForYear ? batchForYear.year : '';

  const defaultBatchId = (programCode + fundingCode + deptCode + year).toUpperCase();

  renderDeptGroupSelects(course, defaultBatchId);

  document.getElementById('modal-dept-group-mapping').classList.remove('hidden');
};

function renderDeptGroupSelects(course, defaultBatchId) {
  const listContainer = document.getElementById('dept-group-selectors-list');
  listContainer.innerHTML = '';

  const countSelect = document.getElementById('dept-group-count-select');
  const count = parseInt(countSelect.value) || 1;

  const cleanCode = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');

  for (let i = 1; i <= count; i++) {
    const div = document.createElement('div');
    div.className = 'form-group mb-2';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '4px';

    const label = document.createElement('label');
    label.style.fontWeight = '600';
    label.style.fontSize = '12px';
    label.textContent = `Class ${i} Batch:`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control dept-group-select-item';
    input.setAttribute('list', 'dept-batch-datalist');
    input.placeholder = 'Type department or code...';
    input.dataset.groupIndex = i;

    // Load preselected batch dynamically matching C{i} or fallback to default
    let savedBatch = '';
    if (count > 1) {
      savedBatch = (state.groupMappings[`${cleanCode}_C${i}`] && state.groupMappings[`${cleanCode}_C${i}`][0]) || '';
    } else {
      savedBatch = (state.groupMappings[cleanCode] && state.groupMappings[cleanCode][0]) || '';
    }

    const preselected = savedBatch || defaultBatchId;
    input.value = preselected;

    // Focus input to highlight current value on click
    input.addEventListener('click', () => {
      input.select();
    });

    div.appendChild(label);
    div.appendChild(input);
    listContainer.appendChild(div);
  }
}

// ==========================================================================
// Automatic Timetable Generator Side Drawer Controller
// ==========================================================================
let tempGeneratedAllocations = null;

function bindAutoGeneratorEvents() {
  const btnOpen = document.getElementById('btn-open-auto-gen');
  const btnClose = document.getElementById('btn-close-auto-gen-drawer');
  const overlay = document.getElementById('side-drawer-overlay');
  const drawer = document.getElementById('side-drawer-auto-gen');
  const semSelect = document.getElementById('auto-gen-sem-select');
  const btnRun = document.getElementById('btn-run-auto-generate');
  const btnApply = document.getElementById('btn-apply-auto-generate');

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert(
          'Timetable Locked',
          `Your timetable is currently ${deptInfo.status}. You cannot generate or alter allocations while it is locked.`,
          'info'
        );
        return;
      }
      openAutoGeneratorDrawer();
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', closeAutoGeneratorDrawer);
  }
  if (overlay) {
    overlay.addEventListener('click', closeAutoGeneratorDrawer);
  }

  if (semSelect) {
    semSelect.addEventListener('change', () => {
      renderAutoGeneratorBindings();
    });
  }

  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      await runAutoGeneration();
    });
  }

  if (btnApply) {
    btnApply.addEventListener('click', async () => {
      await applyAutoGeneratedSchedule();
    });
  }
}

function openAutoGeneratorDrawer() {
  const overlay = document.getElementById('side-drawer-overlay');
  const drawer = document.getElementById('side-drawer-auto-gen');
  const semSelect = document.getElementById('auto-gen-sem-select');
  const resultsCard = document.getElementById('auto-gen-results-card');
  const btnApply = document.getElementById('btn-apply-auto-generate');
  const errBox = document.getElementById('auto-gen-error-alert');

  if (resultsCard) resultsCard.classList.add('hidden');
  if (btnApply) btnApply.classList.add('hidden');
  if (errBox) errBox.classList.add('hidden');
  tempGeneratedAllocations = null;

  // Populate semester dropdown
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const sems = Array.from(new Set(deptCourses.map(c => c.semester))).sort();
  
  if (semSelect) {
    const currentSem = semSelect.value;
    semSelect.innerHTML = '<option value="">All Semesters in Department</option>';
    sems.forEach(s => {
      const label = state.config.semesterLabels[s] || `Semester ${s}`;
      semSelect.innerHTML += `<option value="${s}">${label}</option>`;
    });
    if (sems.includes(currentSem)) semSelect.value = currentSem;
  }

  // Update global locks status badge
  const locksBadge = document.getElementById('auto-gen-global-locks-badge');
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  if (locksBadge) {
    locksBadge.textContent = `${globalLocks.length} Locked`;
  }

  renderAutoGeneratorBindings();

  if (overlay) overlay.classList.add('active');
  if (drawer) drawer.classList.add('active');
}

function closeAutoGeneratorDrawer() {
  const overlay = document.getElementById('side-drawer-overlay');
  const drawer = document.getElementById('side-drawer-auto-gen');
  if (overlay) overlay.classList.remove('active');
  if (drawer) drawer.classList.remove('active');
}

function renderAutoGeneratorBindings() {
  const container = document.getElementById('auto-gen-faculty-bindings-list');
  const countSpan = document.getElementById('auto-gen-courses-count');
  const semSelect = document.getElementById('auto-gen-sem-select');
  if (!container) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  let deptCourses = state.courses.filter(c => c.department === deptName);
  const targetSem = semSelect ? semSelect.value : '';

  if (targetSem) {
    deptCourses = deptCourses.filter(c => String(c.semester) === String(targetSem));
  }

  if (countSpan) countSpan.textContent = deptCourses.length;

  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  if (deptCourses.length === 0) {
    container.innerHTML = `<div class="text-muted text-sm text-center py-2">No courses found for selected semester.</div>`;
    return;
  }

  let html = '';
  deptCourses.forEach(c => {
    // Check existing allocated faculty
    const existingAlloc = state.allocations[c.code] || {};
    const assignedSet = new Set();
    Object.values(existingAlloc).forEach(dayObj => {
      Object.values(dayObj).forEach(facArr => {
        if (Array.isArray(facArr)) facArr.forEach(fc => assignedSet.add(fc));
      });
    });

    const isPrac = (c.courseType === 'P' || c.code.endsWith('-P'));
    const typeBadge = isPrac
      ? `<span class="badge" style="background-color: var(--success-light); color: var(--success-dark); font-size: 10px;">PR</span>`
      : `<span class="badge" style="background-color: var(--warning-light); color: var(--warning-dark); font-size: 10px;">TH</span>`;

    html += `
      <div class="flex-row justify-between items-center py-1" style="border-bottom: 1px dashed var(--border); font-size: 12px;">
        <div style="flex: 1; padding-right: 8px;">
          <strong style="color: var(--text-main);">${c.code}</strong> ${typeBadge}
          <div class="text-muted" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;">${c.name} (Sem ${c.semester})</div>
        </div>
        <div>
          <select class="auto-gen-fac-select form-control" data-course-code="${c.code}" style="font-size: 11px; padding: 2px 6px; height: 28px; width: 140px;">
            <option value="">Auto-Assign</option>
            ${deptFaculty.map(f => {
              const isSelected = assignedSet.has(f.code);
              return `<option value="${f.code}" ${isSelected ? 'selected' : ''}>${f.code} - ${f.name}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function runAutoGeneration() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const semSelect = document.getElementById('auto-gen-sem-select');
  const pinSlotsCheck = document.getElementById('auto-gen-pin-slots');
  const btnRun = document.getElementById('btn-run-auto-generate');
  const btnApply = document.getElementById('btn-apply-auto-generate');
  const resultsCard = document.getElementById('auto-gen-results-card');
  const errBox = document.getElementById('auto-gen-error-alert');

  if (errBox) errBox.classList.add('hidden');
  if (resultsCard) resultsCard.classList.add('hidden');
  if (btnApply) btnApply.classList.add('hidden');

  // Collect Course Faculty Map
  const courseFacultyMap = {};
  document.querySelectorAll('.auto-gen-fac-select').forEach(sel => {
    const cCode = sel.getAttribute('data-course-code');
    const fCode = sel.value.trim();
    if (fCode) {
      courseFacultyMap[cCode] = [fCode];
    }
  });

  // Collect Pinned Slots
  let pinnedSlots = {};
  if (pinSlotsCheck && pinSlotsCheck.checked) {
    pinnedSlots = state.allocations || {};
  }

  btnRun.disabled = true;
  btnRun.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Solving Schedule...`;

  try {
    const res = await authFetch(`${API_BASE}/department/auto-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        semester: semSelect ? semSelect.value : '',
        courseFacultyMap,
        pinnedSlots,
        maxConsecutiveHours: 2,
        practicalBlockSize: 2
      })
    });

    const result = await res.json();
    btnRun.disabled = false;
    btnRun.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Regenerate`;

    if (res.ok && result.success) {
      tempGeneratedAllocations = result.allocations;
      
      document.getElementById('auto-gen-results-msg').textContent = result.message;
      document.getElementById('audit-stat-slots').textContent = result.audit.totalAllocatedSlots;
      document.getElementById('audit-stat-clashes').textContent = result.audit.facultyClashes;
      document.getElementById('audit-stat-practicals').textContent = `${result.audit.practicalBlocksPlaced} Blocks`;
      document.getElementById('audit-stat-violations').textContent = result.audit.teacherConsecutiveViolations;

      if (resultsCard) resultsCard.classList.remove('hidden');
      if (btnApply) btnApply.classList.remove('hidden');
    } else {
      if (errBox) {
        errBox.textContent = result.message || 'Auto-generation failed.';
        errBox.classList.remove('hidden');
      }
    }
  } catch (err) {
    btnRun.disabled = false;
    btnRun.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Timetable`;
    if (errBox) {
      errBox.textContent = 'Connection error during automatic generation.';
      errBox.classList.remove('hidden');
    }
  }
}

async function applyAutoGeneratedSchedule() {
  if (!tempGeneratedAllocations) return;

  const semSelect = document.getElementById('auto-gen-sem-select');
  const targetSem = semSelect ? semSelect.value : '';

  if (targetSem) {
    const deptName = state.currentUser.departmentName;
    const targetCourses = state.courses.filter(c => c.department === deptName && String(c.semester) === String(targetSem));
    const targetCodes = new Set(targetCourses.map(c => c.code));

    Object.keys(tempGeneratedAllocations).forEach(cCode => {
      const base = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
      if (targetCodes.has(cCode) || targetCodes.has(base)) {
        state.allocations[cCode] = tempGeneratedAllocations[cCode];
      }
    });
  } else {
    state.allocations = tempGeneratedAllocations;
  }

  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  await saveDepartmentAllocations(false);

  closeAutoGeneratorDrawer();
  showModalAlert('Schedule Applied', 'The auto-generated schedule has been applied to your timetable workspace and saved as draft!', 'success');
}


