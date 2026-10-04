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
  groupMappings: {},
  teacherUnavailability: {}
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
  if (typeof message === 'string' && message.includes('<')) {
    window.appModal.message.innerHTML = message;
  } else {
    window.appModal.message.textContent = message;
  }
  
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
  if (typeof message === 'string' && message.includes('<')) {
    window.appModal.message.innerHTML = message;
  } else {
    window.appModal.message.textContent = message;
  }
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
  
  // Auto-refresh config when window regains focus or visibility to reflect admin lock/unlock changes
  window.syncGlobalConfigWithAdmin = async function() {
    if (!state.currentUser || !state.currentUser.departmentName) return;
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (res.ok) {
        const freshConfig = await res.json();
        const oldLocks = JSON.stringify((state.config && state.config.globalLockedPeriods) || []);
        const newLocks = JSON.stringify(freshConfig.globalLockedPeriods || []);
        if (oldLocks !== newLocks) {
          state.config = freshConfig;
          renderAllocationMatrix();
          const locksBadge = document.getElementById('auto-gen-global-locks-badge');
          if (locksBadge) {
            locksBadge.textContent = `${(freshConfig.globalLockedPeriods || []).length} Locked`;
          }
        }
      }
    } catch (e) {}
  };

  window.addEventListener('focus', window.syncGlobalConfigWithAdmin);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.syncGlobalConfigWithAdmin();
  });
  setInterval(window.syncGlobalConfigWithAdmin, 4000);
  
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
    const [configRes, deptsRes, coursesRes, facultyRes, batchesRes, groupRes, unavailRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      authFetch(`${API_BASE}/courses`),
      authFetch(`${API_BASE}/faculty`),
      authFetch(`${API_BASE}/batches`),
      authFetch(`${API_BASE}/admin/group-mappings`),
      authFetch(`${API_BASE}/department/teacher-unavailability`)
    ]);
    
    state.config = await configRes.json();
    state.departments = await deptsRes.json();
    state.courses = await coursesRes.json();
    state.faculty = await facultyRes.json();
    state.allBatches = await batchesRes.json();
    state.groupMappings = await groupRes.json();
    if (unavailRes && unavailRes.ok) {
      state.teacherUnavailability = await unavailRes.json();
    }
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
    const [allocRes, configRes] = await Promise.all([
      authFetch(`${API_BASE}/allocations?department=${deptName}`),
      fetch(`${API_BASE}/config`)
    ]);
    state.allocations = await allocRes.json();
    if (configRes && configRes.ok) {
      state.config = await configRes.json();
    }
    
    updateDeptStatusBadge();
    window.populateFiltersDropdowns();
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
    renderDeptDataEditors();
    renderTeacherAvailabilityEditor();
    populateTeacherTimetableDropdowns();
    renderTeacherTimetablesTab();
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

  // Clear Semester Timetable Button
  const btnClearSem = document.getElementById('btn-clear-sem-timetable');
  if (btnClearSem) {
    btnClearSem.addEventListener('click', () => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert('Timetable Locked', `Your department timetable is locked because it is currently ${deptInfo.status}. Clearing allocations is disabled.`, 'warning');
        return;
      }

      const activeSem = state.filters.semester;
      const targetLabel = activeSem ? `Semester ${activeSem}` : 'All Semesters';

      showModalConfirm(
        `Clear ${targetLabel} Allocations?`,
        `Are you sure you want to clear all timetable allocations for ${targetLabel}? All faculty assignments for these courses will be removed.`,
        async () => {
          try {
            const res = await authFetch(`${API_BASE}/department/clear-semester`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                departmentName: state.currentUser.departmentName,
                semester: activeSem || 'all'
              })
            });
            const result = await res.json();
            if (res.ok && result.success) {
              const deptName = state.currentUser.departmentName;
              let deptCourses = state.courses.filter(c => c.department === deptName);
              if (activeSem) {
                deptCourses = deptCourses.filter(c => String(c.semester) === String(activeSem));
              }
              const targetBases = new Set(deptCourses.map(c => c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '')));
              Object.keys(state.allocations).forEach(cCode => {
                const base = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');
                if (targetBases.has(base) || targetBases.has(cCode)) {
                  delete state.allocations[cCode];
                }
              });
              renderAllocationMatrix();
              updateDeptLiveWorkloadTracker();
              triggerAutosave();
              showModalAlert('Timetable Cleared', result.message, 'success');
            } else {
              showModalAlert('Clear Failed', result.message || 'Failed to clear timetable.', 'danger');
            }
          } catch (err) {
            console.error(err);
            showModalAlert('Error', 'Connection error while clearing timetable.', 'danger');
          }
        }
      );
    });
  }

  // Quick-access button at top of workspace
  const btnTopAvail = document.getElementById('btn-open-teacher-availability');
  if (btnTopAvail) {
    btnTopAvail.addEventListener('click', () => {
      document.querySelectorAll('.tab-sub-item').forEach(b => {
        if (b.getAttribute('data-subtab') === 'subtab-dept-availability') b.classList.add('active');
        else b.classList.remove('active');
      });
      document.querySelectorAll('.subtab-pane').forEach(p => {
        if (p.id === 'subtab-dept-availability') p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
      renderTeacherAvailabilityEditor();
      const targetCard = document.getElementById('subtab-dept-availability');
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

      if (subId === 'subtab-dept-availability') {
        renderTeacherAvailabilityEditor();
      }
      if (subId === 'subtab-dept-teacher-timetable') {
        renderTeacherTimetablesTab();
      }
    });
  });


  // Teacher Availability Controls
  const selectAvailTeacher = document.getElementById('select-avail-teacher');
  if (selectAvailTeacher) {
    selectAvailTeacher.addEventListener('change', () => {
      activeUnavailTeacherCode = selectAvailTeacher.value;
      const allUnavail = state.teacherUnavailability || {};
      localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
      loadTeacherUnavailMatrix();
    });
  }

  const btnClearTeacherUnavail = document.getElementById('btn-clear-teacher-unavail');
  if (btnClearTeacherUnavail) {
    btnClearTeacherUnavail.addEventListener('click', () => {
      if (isTimetableLocked()) return;
      localTeacherUnavail = [];
      loadTeacherUnavailMatrix();
    });
  }

  const btnSaveTeacherUnavail = document.getElementById('btn-save-teacher-unavailability');
  if (btnSaveTeacherUnavail) {
    btnSaveTeacherUnavail.addEventListener('click', async () => {
      if (isTimetableLocked()) {
        showModalAlert('Timetable Locked', 'Timetable is locked. Modifying teacher availability is disabled.', 'warning');
        return;
      }
      if (!activeUnavailTeacherCode) return;

      try {
        const res = await authFetch(`${API_BASE}/department/teacher-unavailability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            facultyCode: activeUnavailTeacherCode,
            unavailableSlots: localTeacherUnavail,
            departmentName: state.currentUser.departmentName
          })
        });
        const result = await res.json();
        if (res.ok && result.success) {
          if (!state.teacherUnavailability) state.teacherUnavailability = {};
          state.teacherUnavailability[activeUnavailTeacherCode] = localTeacherUnavail;
          showModalAlert('Saved', `Availability updated for ${activeUnavailTeacherCode}.`, 'success');
        } else {
          showModalAlert('Error', result.message || 'Failed to save availability.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Connection error while saving availability.', 'danger');
      }
    });
  }

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
  bindTeacherTimetableEvents();
  
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
  // Check if period is flagged by Admin for this course's semester
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const courseSem = String((courseT && courseT.semester) || (courseP && courseP.semester) || '').replace(/^Sem(ester)?\s*/i, '').trim();
  const matchingLocks = globalLocks.filter(l => {
    if (l.day.toUpperCase() !== day.toUpperCase()) return false;
    if (String(l.period).trim() !== String(period).trim()) return false;
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    if (!lockSem || lockSem === 'all' || lockSem === '') return true;
    return lockSem === courseSem.toLowerCase();
  });
  // Prefer specific semester match over 'all'
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem.toLowerCase();
  }) || matchingLocks[0];

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
  if (globalLock) {
    classes += ' slot-admin-flagged';
  }

  const lockFlagBadge = globalLock ? `
    <div class="admin-lock-tag" title="Admin Flag: ${globalLock.label || 'Locked Period'}" style="font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
      <i class="fa-solid fa-lock" style="font-size: 9px;"></i> ${globalLock.label || 'Admin Flag'}
    </div>
  ` : '';
  
  const html = `
    <div class="cell-slot" onclick="activateSlot(this, '${baseCode}', '${activeCourseCode}', '${day}', '${period}')">
      ${lockFlagBadge}
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

  const cell = cellContainer.closest('td');
  
  const openSelector = () => {
    cell.classList.add('slot-active');
    openFacultySelectModal(baseCode, activeCourseCode, day, period, cell);
  };

  // Check if period is flagged by Admin
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const course = state.courses.find(c => c.code === activeCourseCode) || state.courses.find(c => c.code === baseCode);
  const courseSem = course ? String(course.semester).replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';
  const matchingLocks = globalLocks.filter(l => {
    if (l.day.toUpperCase() !== day.toUpperCase() || String(l.period).trim() !== String(period).trim()) return false;
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    if (!lockSem || lockSem === 'all' || lockSem === '') return true;
    return lockSem === courseSem;
  });
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem;
  }) || matchingLocks[0];

  if (globalLock) {
    showModalConfirm(
      'Admin Flagged Period',
      `This period (${day} Period ${period}) is flagged institution-wide by Central Admin: "${globalLock.label || 'College Common Activity'}".\n\nDo you want to manually assign a faculty member to this slot?`,
      () => {
        openSelector();
      }
    );
    return;
  }

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
    const unavailList = (state.teacherUnavailability && state.teacherUnavailability[f.code]) || [];
    const isUnavail = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(period)));

    const tr = document.createElement('tr');
    
    // Check which actual course holds this allocation (T or P)
    let assignedCourseCode = courseCode;
    if (isAssigned) {
      if (assignedT.includes(f.code)) assignedCourseCode = courseTCode;
      else if (assignedP.includes(f.code)) assignedCourseCode = coursePCode;
    }
    
    let actionBtn = '';
    if (isAssigned) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" onclick="unassignFacultyFromModal('${assignedCourseCode}', '${f.code}')"><i class="fa-solid fa-user-minus"></i> Remove</button>`;
    } else if (isUnavail) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" disabled title="Faculty member marked this slot off as unavailable"><i class="fa-solid fa-ban"></i> Unavailable</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-xs" onclick="assignFacultyFromModal('${courseCode}', '${f.code}')"><i class="fa-solid fa-user-plus"></i> Assign</button>`;
    }

    tr.innerHTML = `
      <td style="text-align: center;"><span class="fac-pill">${f.code}</span></td>
      <td>
        <strong>${f.name}</strong>
        ${isUnavail ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 10px; margin-left: 6px;"><i class="fa-solid fa-calendar-xmark"></i> Blackout Slot</span>` : ''}
      </td>
      <td style="text-align: center;">
        ${actionBtn}
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
// Teacher Availability / Blackout Days Editor
// -------------------------------------------------------------
let activeUnavailTeacherCode = '';
let localTeacherUnavail = [];

function renderTeacherAvailabilityEditor() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const select = document.getElementById('select-avail-teacher');
  if (!select) return;

  if (deptFaculty.length === 0) {
    select.innerHTML = '<option value="">No faculty found in department</option>';
    return;
  }

  const currentVal = select.value;
  select.innerHTML = '';
  deptFaculty.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.code;
    opt.textContent = `${f.code} - ${f.name}`;
    select.appendChild(opt);
  });

  if (currentVal && deptFaculty.some(f => f.code === currentVal)) {
    select.value = currentVal;
  } else {
    select.value = deptFaculty[0].code;
  }

  activeUnavailTeacherCode = select.value;
  const allUnavail = state.teacherUnavailability || {};
  localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
  loadTeacherUnavailMatrix();
}

function loadTeacherUnavailMatrix() {
  const table = document.getElementById('table-teacher-unavail-matrix');
  const countBadge = document.getElementById('teacher-unavail-status-badge');
  if (!table || !activeUnavailTeacherCode) return;

  const rawPeriods = (state.config && state.config.periods) || ['1', '2', '3', 'LB', '4', '5', '6'];
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  if (countBadge) {
    countBadge.textContent = `${localTeacherUnavail.length} Unavailable Period(s)`;
  }

  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  let headerHtml = '<tr><th style="width: 130px; text-align: center;">Weekday</th>';
  rawPeriods.forEach(p => {
    if (String(p).toUpperCase() === 'LB') {
      headerHtml += '<th style="width: 60px; background: var(--background); font-size: 11px; text-align: center;">LB</th>';
    } else {
      headerHtml += `<th style="text-align: center;">Period ${p}</th>`;
    }
  });
  headerHtml += '<th style="width: 130px; text-align: center;">Quick Action</th></tr>';
  thead.innerHTML = headerHtml;

  let bodyHtml = '';
  weekdays.forEach(day => {
    bodyHtml += `<tr><td style="font-weight: 700; text-align: center; background: var(--surface-1);">${day}</td>`;
    
    rawPeriods.forEach(p => {
      const pStr = String(p).trim();
      if (pStr.toUpperCase() === 'LB') {
        bodyHtml += '<td style="background: var(--background); color: var(--text-muted); font-size: 11px; text-align: center;">LB</td>';
      } else {
        const isOff = localTeacherUnavail.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === pStr));
        if (isOff) {
          // Entire box is solid red! No toggle icons!
          bodyHtml += `
            <td class="teacher-unavail-cell off" data-day="${day}" data-period="${pStr}" title="Click to mark Available">
              <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">UNAVAILABLE</span>
            </td>`;
        } else {
          // Available clean cell! No toggle icons!
          bodyHtml += `
            <td class="teacher-unavail-cell available" data-day="${day}" data-period="${pStr}" title="Click to mark Unavailable">
              <span style="font-size: 11px; font-weight: 500;">Available</span>
            </td>`;
        }
      }
    });

    // Quick Day Toggle button
    const realPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
    const dayOffCount = localTeacherUnavail.filter(u => u.day.toUpperCase() === day.toUpperCase()).length;
    const isDayFull = dayOffCount >= realPeriods.length;

    bodyHtml += `
      <td style="text-align: center;">
        <button type="button" class="btn btn-outline btn-xs btn-toggle-day-off" data-day="${day}" style="font-size: 11px; padding: 4px 10px; ${isDayFull ? 'background: #fee2e2; color: #dc2626; border-color: #fca5a5;' : ''}">
          ${isDayFull ? 'Clear Day' : 'Mark Day Off'}
        </button>
      </td>
    </tr>`;
  });
  tbody.innerHTML = bodyHtml;

  // Bind cell clicks to toggle availability
  table.querySelectorAll('.teacher-unavail-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.preventDefault();
      if (isTimetableLocked()) return;
      const day = cell.getAttribute('data-day');
      const period = cell.getAttribute('data-period');
      
      const idx = localTeacherUnavail.findIndex(u => u.day.toUpperCase() === day.toUpperCase() && String(u.period) === String(period));
      if (idx >= 0) {
        localTeacherUnavail.splice(idx, 1);
      } else {
        localTeacherUnavail.push({ day, period: String(period) });
      }
      loadTeacherUnavailMatrix();
    });
  });

  // Bind Day Toggle buttons
  table.querySelectorAll('.btn-toggle-day-off').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (isTimetableLocked()) return;
      const day = btn.getAttribute('data-day');
      const realPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
      const dayCount = localTeacherUnavail.filter(u => u.day.toUpperCase() === day.toUpperCase()).length;

      if (dayCount >= realPeriods.length) {
        // Clear all entries for this day
        localTeacherUnavail = localTeacherUnavail.filter(u => u.day.toUpperCase() !== day.toUpperCase());
      } else {
        // Mark all real periods of this day
        realPeriods.forEach(p => {
          if (!localTeacherUnavail.some(u => u.day.toUpperCase() === day.toUpperCase() && String(u.period) === String(p))) {
            localTeacherUnavail.push({ day, period: String(p) });
          }
        });
      }
      loadTeacherUnavailMatrix();
    });
  });
}


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


// =============================================================
// TEACHER-WISE TIMETABLE ENGINE & PDF EXPORT
// =============================================================

function computeFacultyWeeklySchedules(deptName) {
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

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

  const deptAlloc = state.allocations || {};

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
              if (isPrac) {
                schedules[facCode].practicalHours++;
              } else {
                schedules[facCode].theoryHours++;
              }
            }
          });
        }
      });
    });
  });

  return schedules;
}

function renderTeacherTimetableSheet(facSchedule, displayMode, periods, deptName) {
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const fac = facSchedule.info;

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

      const assignedList = facSchedule.slots[day] && facSchedule.slots[day][p];
      if (assignedList && assignedList.length > 0) {
        const itemHtmls = assignedList.map(item => {
          const isP = item.type === 'P';
          const typeLabel = isP ? 'PR' : 'TH';
          
          let dispText = item.courseAlias;
          if (displayMode === 'short') {
            dispText = item.courseCode;
          } else if (displayMode === 'full') {
            dispText = `${item.courseName} (${item.courseCode})`;
          } else {
            dispText = `${item.courseAlias || item.courseCode}`;
          }

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
            <i class="fa-solid fa-clock"></i> Total: <strong>${facSchedule.totalHours} hrs/week</strong>
          </span>
          <span class="teacher-stat-badge teacher-stat-th" title="Theory hours per week">
            <i class="fa-solid fa-book-open"></i> Theory: <strong>${facSchedule.theoryHours} hrs</strong>
          </span>
          <span class="teacher-stat-badge teacher-stat-pr" title="Practical lab hours per week">
            <i class="fa-solid fa-flask"></i> Practical: <strong>${facSchedule.practicalHours} hrs</strong>
          </span>
        </div>
      </div>

      <table class="teacher-grid-table">
        <thead>${theadHtml}</thead>
        <tbody>${tbodyHtml}</tbody>
      </table>
    </div>
  `;
}

function renderTeacherTimetables(containerElement, targetFacultyCode = 'ALL', displayMode = 'medium') {
  if (!containerElement) return;
  const deptName = state.currentUser ? state.currentUser.departmentName : 'Department';
  const schedules = computeFacultyWeeklySchedules(deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];

  const facultyList = targetFacultyCode === 'ALL'
    ? Object.values(schedules)
    : [schedules[targetFacultyCode]].filter(Boolean);

  if (facultyList.length === 0) {
    containerElement.innerHTML = `
      <div class="text-center text-muted" style="padding: 40px 20px;">
        <i class="fa-solid fa-user-slash" style="font-size: 36px; margin-bottom: 12px; color: #cbd5e1;"></i>
        <p>No faculty members found for this department.</p>
      </div>
    `;
    return;
  }

  containerElement.innerHTML = facultyList.map(facSched => {
    return renderTeacherTimetableSheet(facSched, displayMode, periods, deptName);
  }).join('');
}

function populateTeacherTimetableDropdowns() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  const modalSelect = document.getElementById('select-teacher-timetable-faculty');
  const tabSelect = document.getElementById('tab-select-teacher-faculty');

  const optionsHtml = `
    <option value="ALL">All Teachers (${deptFaculty.length} Faculty Members)</option>
    ${deptFaculty.map(f => `<option value="${f.code}">${f.name} (${f.code})</option>`).join('')}
  `;

  if (modalSelect) modalSelect.innerHTML = optionsHtml;
  if (tabSelect) tabSelect.innerHTML = optionsHtml;
}

function openTeacherTimetableModal(selectedFacultyCode = 'ALL') {
  populateTeacherTimetableDropdowns();
  
  const modalSelect = document.getElementById('select-teacher-timetable-faculty');
  if (modalSelect) {
    modalSelect.value = selectedFacultyCode;
  }

  const modeSelect = document.getElementById('select-teacher-timetable-mode');
  const mode = modeSelect ? modeSelect.value : 'medium';

  const container = document.getElementById('teacher-print-area');
  renderTeacherTimetables(container, selectedFacultyCode, mode);

  const modal = document.getElementById('modal-teacher-timetable');
  if (modal) modal.classList.remove('hidden');
}

function renderTeacherTimetablesTab() {
  populateTeacherTimetableDropdowns();
  const tabSelect = document.getElementById('tab-select-teacher-faculty');
  const selectedFacultyCode = tabSelect ? tabSelect.value : 'ALL';
  const container = document.getElementById('tab-teacher-timetable-container');
  renderTeacherTimetables(container, selectedFacultyCode, 'medium');
}

function exportTeacherTimetableToCSV(targetFacultyCode = 'ALL') {
  const deptName = state.currentUser ? state.currentUser.departmentName : 'Department';
  const schedules = computeFacultyWeeklySchedules(deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

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

function bindTeacherTimetableEvents() {
  const btnOpenToolbar = document.getElementById('btn-open-teacher-timetable');
  if (btnOpenToolbar) {
    btnOpenToolbar.addEventListener('click', () => {
      openTeacherTimetableModal('ALL');
    });
  }

  const btnCloseModal = document.getElementById('btn-close-teacher-modal');
  if (btnCloseModal) {
    btnCloseModal.addEventListener('click', () => {
      const modal = document.getElementById('modal-teacher-timetable');
      if (modal) modal.classList.add('hidden');
    });
  }

  const modalSelectFac = document.getElementById('select-teacher-timetable-faculty');
  const modalSelectMode = document.getElementById('select-teacher-timetable-mode');
  const printArea = document.getElementById('teacher-print-area');

  if (modalSelectFac && printArea) {
    modalSelectFac.addEventListener('change', () => {
      const mode = modalSelectMode ? modalSelectMode.value : 'medium';
      renderTeacherTimetables(printArea, modalSelectFac.value, mode);
    });
  }

  if (modalSelectMode && printArea) {
    modalSelectMode.addEventListener('change', () => {
      const facCode = modalSelectFac ? modalSelectFac.value : 'ALL';
      renderTeacherTimetables(printArea, facCode, modalSelectMode.value);
    });
  }

  const btnPrint = document.getElementById('btn-trigger-teacher-print');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      window.print();
    });
  }

  const btnExportCsv = document.getElementById('btn-export-teacher-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      const facCode = modalSelectFac ? modalSelectFac.value : 'ALL';
      exportTeacherTimetableToCSV(facCode);
    });
  }

  // Tab controls
  const tabSelectFac = document.getElementById('tab-select-teacher-faculty');
  const tabContainer = document.getElementById('tab-teacher-timetable-container');
  if (tabSelectFac && tabContainer) {
    tabSelectFac.addEventListener('change', () => {
      renderTeacherTimetables(tabContainer, tabSelectFac.value, 'medium');
    });
  }

  const tabBtnModal = document.getElementById('tab-btn-open-teacher-modal');
  if (tabBtnModal) {
    tabBtnModal.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
    });
  }

  const tabBtnPrint = document.getElementById('tab-btn-print-teacher-pdf');
  if (tabBtnPrint) {
    tabBtnPrint.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
      setTimeout(() => {
        window.print();
      }, 350);
    });
  }

  const btnSwitchTeacher = document.getElementById('btn-switch-to-teacher-timetable');
  if (btnSwitchTeacher) {
    btnSwitchTeacher.addEventListener('click', () => {
      const printModal = document.getElementById('modal-print-preview');
      if (printModal) printModal.classList.add('hidden');
      openTeacherTimetableModal('ALL');
    });
  }
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

let autoGenCourseFacultyBindings = {};
let autoGenCourseFacultyConfig = {};

function renderAutoGeneratorBindings() {
  const container = document.getElementById('auto-gen-faculty-bindings-list');
  const countSpan = document.getElementById('auto-gen-courses-count');
  const semSelect = document.getElementById('auto-gen-sem-select');
  const selectAllCb = document.getElementById('auto-gen-select-all-courses');
  if (!container) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  let deptCourses = state.courses.filter(c => c.department === deptName);
  const targetSem = semSelect ? semSelect.value : '';

  if (targetSem) {
    deptCourses = deptCourses.filter(c => String(c.semester) === String(targetSem));
  }

  function updateSelectedCount() {
    const allCbs = container.querySelectorAll('.auto-gen-course-cb');
    const checkedCbs = container.querySelectorAll('.auto-gen-course-cb:checked');
    if (countSpan) countSpan.textContent = `${checkedCbs.length} of ${allCbs.length}`;
    if (selectAllCb) {
      selectAllCb.checked = allCbs.length > 0 && checkedCbs.length === allCbs.length;
      selectAllCb.indeterminate = checkedCbs.length > 0 && checkedCbs.length < allCbs.length;
    }
  }

  if (deptCourses.length === 0) {
    container.innerHTML = `<div class="text-muted text-sm text-center py-2">No courses found for selected semester.</div>`;
    if (countSpan) countSpan.textContent = '0';
    if (selectAllCb) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
    return;
  }

  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  let html = '';
  deptCourses.forEach(c => {
    // Check existing allocated faculty if not already bound
    if (autoGenCourseFacultyBindings[c.code] === undefined) {
      const existingAlloc = state.allocations[c.code] || {};
      const assignedSet = new Set();
      Object.values(existingAlloc).forEach(dayObj => {
        Object.values(dayObj).forEach(facArr => {
          if (Array.isArray(facArr)) facArr.forEach(fc => assignedSet.add(fc));
        });
      });
      autoGenCourseFacultyBindings[c.code] = Array.from(assignedSet);
      autoGenCourseFacultyConfig[c.code] = { distribute: true };
    }

    const selectedFacs = autoGenCourseFacultyBindings[c.code] || [];
    const isDistribute = (autoGenCourseFacultyConfig[c.code] && autoGenCourseFacultyConfig[c.code].distribute !== false);

    let summaryText = 'Auto-Assign';
    if (selectedFacs.length === 1) {
      summaryText = `${selectedFacs[0]} (1 Teacher)`;
    } else if (selectedFacs.length > 1) {
      summaryText = `${selectedFacs.join(', ')} (${selectedFacs.length} Teachers)`;
    }

    const isPrac = (c.courseType === 'P' || c.code.endsWith('-P'));
    const typeBadge = isPrac
      ? `<span class="badge" style="background-color: var(--success-light); color: var(--success-dark); font-size: 10px;">PR</span>`
      : `<span class="badge" style="background-color: var(--warning-light); color: var(--warning-dark); font-size: 10px;">TH</span>`;

    html += `
      <div class="auto-gen-course-item" data-course-code="${c.code}" style="border-bottom: 1px dashed var(--border); padding: 8px 4px;">
        <div class="flex-row justify-between items-center" style="gap: 8px;">
          <!-- Course Checkbox & Name -->
          <div class="flex-row items-center" style="gap: 8px; flex: 1; min-width: 0;">
            <input type="checkbox" class="auto-gen-course-cb" value="${c.code}" checked style="accent-color: var(--primary); width: 15px; height: 15px; cursor: pointer;">
            <div style="flex: 1; min-width: 0;">
              <div class="flex-row items-center gap-1">
                <strong style="color: var(--text-main); font-size: 13px;">${c.code}</strong> ${typeBadge}
              </div>
              <div class="text-muted" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;" title="${c.name}">${c.name} (Sem ${c.semester})</div>
            </div>
          </div>

          <!-- Multi-Teacher Dropdown Trigger -->
          <div>
            <button type="button" class="btn btn-outline btn-xs btn-toggle-fac-dropdown" data-course-code="${c.code}" style="font-size: 11px; padding: 4px 8px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; border-color: ${selectedFacs.length > 0 ? 'var(--primary)' : 'var(--border)'}; background: ${selectedFacs.length > 0 ? 'var(--primary-light)' : '#ffffff'}; color: ${selectedFacs.length > 0 ? 'var(--primary)' : 'var(--text-main)'}; border-radius: 4px;">
              <i class="fa-solid fa-user-group text-primary"></i>
              <span class="fac-btn-label">${summaryText}</span>
              <i class="fa-solid fa-chevron-down" style="font-size: 9px; opacity: 0.7;"></i>
            </button>
          </div>
        </div>

        <!-- Selected Faculty Badges & Distribution indicator -->
        <div class="fac-selected-pills-row" id="fac-pills-${c.code}" style="display: ${selectedFacs.length > 0 ? 'flex' : 'none'}; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 4px; padding-left: 23px;">
          ${selectedFacs.map(fCode => `<span class="badge" style="background: #e0e7ff; color: #3730a3; font-size: 10px; padding: 2px 6px; font-weight: 700;">${fCode}</span>`).join('')}
          ${selectedFacs.length > 1 ? `<span class="badge fac-distribute-badge" id="dist-badge-${c.code}" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 6px; font-weight: 600; display: ${isDistribute ? 'inline-flex' : 'none'}; align-items: center; gap: 4px;"><i class="fa-solid fa-shuffle"></i> Distributed by Availability</span>` : ''}
        </div>

        <!-- Popover Checklist with Checkboxes for Multiple Teachers -->
        <div class="fac-checklist-popover hidden" id="fac-popover-${c.code}" style="margin-top: 8px; margin-left: 23px; background: #ffffff; border: 1.5px solid var(--primary); border-radius: 6px; padding: 10px; box-shadow: 0 4px 14px rgba(0,0,0,0.12); font-size: 11px;">
          <div style="font-weight: 700; color: var(--text-main); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span><i class="fa-solid fa-users text-primary"></i> Select Teachers for ${c.code}:</span>
            <span class="text-muted" style="font-size: 10px; font-weight: normal;">(Check multiple to share)</span>
          </div>

          <!-- Quick filter input if faculty count > 5 -->
          ${deptFaculty.length > 5 ? `
            <input type="text" class="form-control form-control-sm fac-search-filter mb-2" data-course-code="${c.code}" placeholder="Filter teachers by name or code..." style="font-size: 11px; padding: 3px 6px; height: 26px;">
          ` : ''}

          <!-- Checklist of Teachers -->
          <div class="fac-checkbox-list" data-course-code="${c.code}" style="max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--border); border-radius: 4px; padding: 6px; background: var(--surface);">
            ${deptFaculty.map(f => {
              const isChecked = selectedFacs.includes(f.code);
              return `
                <label class="fac-cb-item" style="display: flex; align-items: center; gap: 7px; padding: 3px 5px; cursor: pointer; border-radius: 3px; user-select: none;">
                  <input type="checkbox" class="auto-gen-fac-cb" data-course-code="${c.code}" data-fac-code="${f.code}" ${isChecked ? 'checked' : ''} style="accent-color: var(--primary); width: 14px; height: 14px; cursor: pointer;">
                  <span style="font-weight: 700; color: var(--primary); min-width: 32px;">${f.code}</span>
                  <span style="color: var(--text-main); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.name}</span>
                </label>
              `;
            }).join('')}
          </div>

          <!-- Multi-Teacher Distribution Mode Settings (visible when 2+ teachers checked) -->
          <div class="fac-distribute-box" id="distribute-box-${c.code}" style="display: ${selectedFacs.length > 1 ? 'block' : 'none'}; margin-top: 8px; padding: 6px 8px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px;">
            <label style="display: flex; align-items: flex-start; gap: 6px; cursor: pointer; margin: 0; color: #166534; font-weight: 600; font-size: 11px;">
              <input type="checkbox" class="auto-gen-distribute-cb" data-course-code="${c.code}" ${isDistribute ? 'checked' : ''} style="accent-color: #16a34a; width: 14px; height: 14px; margin-top: 2px;">
              <span>Distribute periods across selected teachers according to availability</span>
            </label>
            <div style="font-size: 10px; color: #15803d; margin-left: 20px; margin-top: 2px;">
              The timetable engine divides this subject's hours among the selected teachers, automatically matching each teacher's free periods and blackout days.
            </div>
          </div>

          <!-- Actions: Clear & Done -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border);">
            <button type="button" class="btn btn-outline btn-xs btn-clear-course-fac" data-course-code="${c.code}" style="font-size: 10px; padding: 2px 8px;">Clear Selection</button>
            <button type="button" class="btn btn-primary btn-xs btn-close-fac-popover" data-course-code="${c.code}" style="font-size: 10px; padding: 2px 12px;">Done</button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateSelectedCount();

  // Attach course checkbox change handlers
  container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
    cb.addEventListener('change', updateSelectedCount);
  });

  // Attach popover toggle handlers
  container.querySelectorAll('.btn-toggle-fac-dropdown').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (!popover) return;

      const isOpening = popover.classList.contains('hidden');
      // Close any other open popovers
      container.querySelectorAll('.fac-checklist-popover').forEach(p => p.classList.add('hidden'));

      if (isOpening) {
        popover.classList.remove('hidden');
      }
    });
  });

  // Attach Done buttons
  container.querySelectorAll('.btn-close-fac-popover').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (popover) popover.classList.add('hidden');
    });
  });

  // Attach Clear Selection buttons
  container.querySelectorAll('.btn-clear-course-fac').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      autoGenCourseFacultyBindings[cCode] = [];
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (popover) {
        popover.querySelectorAll('.auto-gen-fac-cb').forEach(cb => { cb.checked = false; });
      }
      updateCourseFacultyUI(cCode);
    });
  });

  // Attach teacher checkbox change handlers
  container.querySelectorAll('.auto-gen-fac-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      const checkedCbs = container.querySelectorAll(`.auto-gen-fac-cb[data-course-code="${cCode}"]:checked`);
      autoGenCourseFacultyBindings[cCode] = Array.from(checkedCbs).map(c => c.getAttribute('data-fac-code'));
      updateCourseFacultyUI(cCode);
    });
  });

  // Attach distribute toggle checkbox
  container.querySelectorAll('.auto-gen-distribute-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      if (!autoGenCourseFacultyConfig[cCode]) autoGenCourseFacultyConfig[cCode] = {};
      autoGenCourseFacultyConfig[cCode].distribute = cb.checked;
      const distBadge = document.getElementById(`dist-badge-${cCode}`);
      if (distBadge) {
        distBadge.style.display = cb.checked ? 'inline-flex' : 'none';
      }
    });
  });

  // Quick search filter inside popover
  container.querySelectorAll('.fac-search-filter').forEach(input => {
    input.addEventListener('input', (e) => {
      const cCode = input.getAttribute('data-course-code');
      const q = e.target.value.toLowerCase().trim();
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (!popover) return;
      popover.querySelectorAll('.fac-cb-item').forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });
  });

  function updateCourseFacultyUI(cCode) {
    const selected = autoGenCourseFacultyBindings[cCode] || [];
    const btn = container.querySelector(`.btn-toggle-fac-dropdown[data-course-code="${cCode}"]`);
    const label = btn ? btn.querySelector('.fac-btn-label') : null;
    const pillsRow = document.getElementById(`fac-pills-${cCode}`);
    const distBox = document.getElementById(`distribute-box-${cCode}`);

    let text = 'Auto-Assign';
    if (selected.length === 1) {
      text = `${selected[0]} (1 Teacher)`;
    } else if (selected.length > 1) {
      text = `${selected.join(', ')} (${selected.length} Teachers)`;
    }
    if (label) label.textContent = text;

    if (btn) {
      btn.style.borderColor = selected.length > 0 ? 'var(--primary)' : 'var(--border)';
      btn.style.background = selected.length > 0 ? 'var(--primary-light)' : '#ffffff';
      btn.style.color = selected.length > 0 ? 'var(--primary)' : 'var(--text-main)';
    }

    if (pillsRow) {
      pillsRow.style.display = selected.length > 0 ? 'flex' : 'none';
      const isDist = (autoGenCourseFacultyConfig[cCode] && autoGenCourseFacultyConfig[cCode].distribute !== false);
      pillsRow.innerHTML = `
        ${selected.map(fCode => `<span class="badge" style="background: #e0e7ff; color: #3730a3; font-size: 10px; padding: 2px 6px; font-weight: 700;">${fCode}</span>`).join('')}
        ${selected.length > 1 ? `<span class="badge fac-distribute-badge" id="dist-badge-${cCode}" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 6px; font-weight: 600; display: ${isDist ? 'inline-flex' : 'none'}; align-items: center; gap: 4px;"><i class="fa-solid fa-shuffle"></i> Distributed by Availability</span>` : ''}
      `;
    }

    if (distBox) {
      distBox.style.display = selected.length > 1 ? 'block' : 'none';
    }
  }

  if (selectAllCb) {
    selectAllCb.onchange = () => {
      const isChecked = selectAllCb.checked;
      container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
        cb.checked = isChecked;
      });
      updateSelectedCount();
    };
  }
}

async function runAutoGeneration(forceRelaxed = false) {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const semSelect = document.getElementById('auto-gen-sem-select');
  const pinSlotsCheck = document.getElementById('auto-gen-pin-slots');
  const btnRun = document.getElementById('btn-run-auto-generate');
  const btnApply = document.getElementById('btn-apply-auto-generate');
  const resultsCard = document.getElementById('auto-gen-results-card');
  const errBox = document.getElementById('auto-gen-error-alert');
  const suggestionsBox = document.getElementById('auto-gen-suggestions-box');

  if (errBox) errBox.classList.add('hidden');
  if (resultsCard) resultsCard.classList.add('hidden');
  if (btnApply) btnApply.classList.add('hidden');
  if (suggestionsBox) suggestionsBox.classList.add('hidden');

  // Collect Selected Courses
  const checkedBoxes = Array.from(document.querySelectorAll('.auto-gen-course-cb:checked'));
  if (checkedBoxes.length === 0) {
    if (errBox) {
      errBox.textContent = 'Please select at least one course to generate schedule.';
      errBox.classList.remove('hidden');
    }
    return;
  }
  const selectedCourseCodes = checkedBoxes.map(cb => cb.value);

  // Collect Course Faculty Map & Config (Supporting Multi-Teacher Selection)
  const courseFacultyMap = {};
  const courseFacultyConfig = {};

  Object.entries(autoGenCourseFacultyBindings).forEach(([cCode, facList]) => {
    if (Array.isArray(facList) && facList.length > 0) {
      courseFacultyMap[cCode] = facList;
      const isDistribute = (autoGenCourseFacultyConfig[cCode] && autoGenCourseFacultyConfig[cCode].distribute !== false);
      courseFacultyConfig[cCode] = {
        teachers: facList,
        distribute: isDistribute && facList.length > 1
      };
    }
  });

  // Collect Pinned Slots
  let pinnedSlots = {};
  if (pinSlotsCheck && pinSlotsCheck.checked) {
    pinnedSlots = state.allocations || {};
  }

  btnRun.disabled = true;
  btnRun.innerHTML = forceRelaxed 
    ? `<i class="fa-solid fa-spinner fa-spin"></i> Solving with Smart Exceptions...` 
    : `<i class="fa-solid fa-spinner fa-spin"></i> Solving Schedule...`;

  try {
    const res = await authFetch(`${API_BASE}/department/auto-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        semester: semSelect ? semSelect.value : '',
        courseFacultyMap,
        courseFacultyConfig,
        pinnedSlots,
        selectedCourseCodes,
        maxConsecutiveHours: 2,
        practicalBlockSize: 2,
        forceRelaxed: !!forceRelaxed
      })
    });

    const result = await res.json();
    btnRun.disabled = false;
    btnRun.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Regenerate`;

    if (res.ok && result.success) {
      tempGeneratedAllocations = result.allocations;
      
      const resultsMsg = document.getElementById('auto-gen-results-msg');
      if (result.status === 'relaxed_with_exceptions') {
        const excCount = result.exceptions ? result.exceptions.length : 0;
        let exceptionsListHtml = '';
        if (result.exceptions && result.exceptions.length > 0) {
          exceptionsListHtml = `
            <div style="margin-top: 6px; font-size: 11px; color: #92400e;">
              <strong>Applied Smart Exceptions (${excCount}):</strong>
              <ul style="margin: 2px 0 0 16px; padding: 0;">
                ${result.exceptions.map(e => `<li>${e.reason}</li>`).join('')}
              </ul>
            </div>
          `;
        }
        if (resultsMsg) {
          resultsMsg.innerHTML = `
            <span style="color: #b45309; font-weight: 700;"><i class="fa-solid fa-triangle-exclamation"></i> Feasible Schedule Generated via Smart Exceptions:</span>
            ${result.message}
            ${exceptionsListHtml}
          `;
        }
      } else {
        if (resultsMsg) resultsMsg.textContent = result.message;
      }

      document.getElementById('audit-stat-slots').textContent = result.audit.totalAllocatedSlots;
      document.getElementById('audit-stat-clashes').textContent = result.audit.facultyClashes;
      document.getElementById('audit-stat-practicals').textContent = `${result.audit.practicalBlocksPlaced} Blocks`;
      document.getElementById('audit-stat-violations').textContent = result.audit.teacherConsecutiveViolations;

      // Render suggestions if available
      if (suggestionsBox) {
        if (result.suggestions && result.suggestions.length > 0) {
          suggestionsBox.innerHTML = `
            <div style="font-weight: 600; color: #b45309; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-lightbulb"></i> Constraint Insights & Optimizations:
            </div>
            <ul style="margin: 0; padding-left: 18px; color: #78350f; font-size: 11px; line-height: 1.5;">
              ${result.suggestions.map(s => `<li>${s}</li>`).join('')}
            </ul>
          `;
          suggestionsBox.classList.remove('hidden');
        } else {
          suggestionsBox.classList.add('hidden');
        }
      }

      if (resultsCard) resultsCard.classList.remove('hidden');
      if (btnApply) btnApply.classList.remove('hidden');

      // If triggered by "Solve with Smart Exceptions", automatically apply to timetable workspace
      if (forceRelaxed) {
        await applyAutoGeneratedSchedule();
      }
    } else {
      if (errBox) {
        let msgHtml = `<div><strong>${result.message || 'Auto-generation failed under strict constraints.'}</strong></div>`;
        if (result.suggestions && result.suggestions.length > 0) {
          msgHtml += `
            <div style="margin-top: 8px; font-weight: 600;">Diagnosed Bottlenecks & Recommendations:</div>
            <ul style="margin-top: 4px; margin-bottom: 8px; padding-left: 18px; font-size: 11px;">
              ${result.suggestions.map(s => `<li>${s}</li>`).join('')}
            </ul>
          `;
        }

        // Add interactive Solve with Exceptions button
        if (result.canAutoResolve || (result.suggestions && result.suggestions.length > 0)) {
          msgHtml += `
            <div class="mt-2 pt-2" style="border-top: 1px dashed rgba(220, 38, 38, 0.3); display: flex; justify-content: flex-end;">
              <button type="button" id="btn-auto-resolve-exceptions" class="btn btn-sm" style="font-weight: 700; background: #f59e0b; color: #78350f; border: 1px solid #d97706; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 12px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                <i class="fa-solid fa-wrench"></i> Solve with Smart Exceptions
              </button>
            </div>
          `;
        }

        errBox.innerHTML = msgHtml;
        errBox.classList.remove('hidden');

        // Bind Solve with Exceptions button
        const btnResolve = document.getElementById('btn-auto-resolve-exceptions');
        if (btnResolve) {
          btnResolve.addEventListener('click', () => {
            // Build dynamic summary based on diagnosed bottlenecks
            const diag = result.diagnostics || {};
            const summaryItems = [];

            const bottleneckFac = Object.keys(diag.bottleneckFaculty || {});
            if (bottleneckFac.length > 0 || (diag.rejectionCounts && diag.rejectionCounts.TEACHER_FATIGUE > 0)) {
              const facLabels = bottleneckFac.map(code => {
                const fObj = state.faculty.find(f => f.code === code);
                return fObj ? `${fObj.name} (${code})` : code;
              });
              summaryItems.push(`
                <li><strong>Teacher Rest Limit Flexibility:</strong> Allows teachers to teach up to 3 or 4 consecutive hours where necessary to complete your timetable${facLabels.length > 0 ? ` (constrained faculty: <em>${facLabels.join(', ')}</em>)` : ''}.</li>
              `);
            }

            if (diag.rejectionCounts && diag.rejectionCounts.TEACHER_UNAVAILABLE > 0) {
              summaryItems.push(`
                <li><strong>Teacher Blackout Flexibility:</strong> Relaxes teacher unwanted periods where strictly necessary to resolve timetable deadlocks.</li>
              `);
            }

            if (diag.rejectionCounts && diag.rejectionCounts.SHIFT_BALANCE > 0) {
              summaryItems.push(`
                <li><strong>Shift Balancing Adaptation:</strong> Relaxes morning/afternoon shift division to place remaining course hours into available periods.</li>
              `);
            }

            if (diag.rejectionCounts && diag.rejectionCounts.SAME_PERIOD_REPETITION > 0) {
              summaryItems.push(`
                <li><strong>Period Repetition Flexibility:</strong> Relaxes anti-mono-period rules when distinct periods are fully booked.</li>
              `);
            }

            if (diag.rejectionCounts && diag.rejectionCounts.SAME_DAY_STACKING > 0) {
              summaryItems.push(`
                <li><strong>Daily Course Hour Cap:</strong> Permits up to 3 hours for multi-hour theory courses on a single day if needed.</li>
              `);
            }

            if (summaryItems.length === 0) {
              summaryItems.push(`
                <li><strong>Continuous Rest & Shift Relaxation:</strong> Relaxes soft rest intervals and shift balancing to accommodate all required course hours.</li>
              `);
            }

            const confirmMessage = `
              <div style="text-align: left; font-size: 13px; line-height: 1.5; color: var(--text-main);">
                <p>Generating with smart exceptions will resolve the diagnosed deadlocks by applying the following dynamic relaxations:</p>
                <ul style="margin: 8px 0 12px 18px; padding: 0; color: #b45309;">
                  ${summaryItems.join('')}
                </ul>
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 4px; padding: 8px 10px; color: #166534; font-size: 12px; margin-top: 8px;">
                  <i class="fa-solid fa-shield-halved"></i> <strong>Guaranteed Hard Invariants:</strong>
                  <div style="margin-top: 2px;">• Zero teacher clashes across all departments</div>
                  <div>• Zero student cohort clashes</div>
                  <div>• Lunch break (LB) periods strictly protected</div>
                </div>
                <p style="margin-top: 10px; font-weight: 600;">Would you like to proceed and generate the schedule with these exceptions?</p>
              </div>
            `;

            showModalConfirm(
              'Solve Timetable with Smart Exceptions',
              confirmMessage,
              async () => {
                await runAutoGeneration(true);
              }
            );
          });
        }
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
    Object.keys(tempGeneratedAllocations).forEach(cCode => {
      state.allocations[cCode] = tempGeneratedAllocations[cCode];
    });
  }

  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  await saveDepartmentAllocations(false);

  closeAutoGeneratorDrawer();
  showModalAlert('Schedule Applied', 'The auto-generated schedule has been applied to your timetable workspace and saved as draft!', 'success');
}



