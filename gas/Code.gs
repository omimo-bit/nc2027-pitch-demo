/**
 * NC 2027 Pitch Demo - Google Apps Script Backend
 * ------------------------------------------------
 * Purpose: free pitch/demo backend using Google Sheets.
 * Frontend is hosted on Vercel. This script is ONLY the API backend.
 * No Google Cloud project or advanced service is required.
 */

var APP_NAME = 'NC 2027 Pitch Demo';
var PROP_DB_ID = 'NC2027_DEMO_SPREADSHEET_ID';
var PROP_API_KEY = 'NC2027_DEMO_API_KEY';
var PROP_EVIDENCE_FOLDER_ID = 'NC2027_DEMO_EVIDENCE_FOLDER_ID';

var SHEETS = {
  Users: ['user_id','employee_code','full_name','role_id','phone','email','status','pin'],
  Assignments: ['assignment_id','user_id','supervisor_id','region_id','area_id','effective_start','effective_end'],
  Regions: ['region_id','region_code','region_name','status'],
  Areas: ['area_id','region_id','area_code','area_name','status'],
  Stores: ['store_id','store_code','store_name','channel','region_id','area_id','address','city','latitude','longitude','gps_radius','status'],
  Products: ['product_id','brand','category','sku_code','sku_name','size','uom','status'],
  PJP: ['pjp_id','period','nc_id','status','created_by','created_at'],
  PJPVisits: ['pjp_visit_id','pjp_id','visit_date','store_id','sequence','planned_start','planned_end','status'],
  TaskDefinitions: ['task_id','task_code','task_name','frequency','required','requires_photo','requires_gps','status'],
  VisitTasks: ['visit_task_id','visit_id','task_id','status','started_at','completed_at','validation_status'],
  Submissions: ['submission_id','visit_id','task_id','user_id','store_id','submitted_at','device_timestamp','server_timestamp','latitude','longitude','sync_source','submission_status','validation_status','idempotency_key','version'],
  StockTaking: ['stock_id','submission_id','product_id','system_stock','physical_stock','stock_gap','remark'],
  Offtake: ['offtake_id','submission_id','product_id','quantity','value','source','period_start','period_end'],
  PriceMonitoring: ['price_id','submission_id','product_id','our_price','competitor_product','competitor_price','promotion_type','promotion_description'],
  CompetitorActivity: ['competitor_activity_id','submission_id','competitor','activity_type','product_id','price','promotion','display','gwp','observation'],
  GWPAllocations: ['allocation_id','period','gwp_id','allocation_level','region_id','area_id','store_id','nc_id','allocated_qty'],
  GWPTransactions: ['transaction_id','submission_id','gwp_id','transaction_type','quantity','consumer_id','store_id','nc_id'],
  Consumers: ['consumer_id','created_at','created_by','status'],
  ConsumerInteractions: ['interaction_id','consumer_id','nc_id','store_id','visit_id','interaction_date','interaction_type','product_id','remark'],
  ValidationResults: ['validation_id','submission_id','rule_id','severity','status','expected_value','actual_value','message','validated_at'],
  CorrectionRequests: ['correction_id','submission_id','requested_by','requested_at','reason','status','assigned_to','resolved_at'],
  SubmissionVersions: ['submission_id','version','payload_snapshot','changed_by','changed_at','reason'],
  Targets: ['target_id','period','kpi_id','target_level','region_id','area_id','tl_id','nc_id','store_id','target_value','version','status'],
  DailyNCKPI: ['date','region_id','kpi_id','target','actual','achievement'],
  AuditLogs: ['audit_id','actor_id','action','entity_type','entity_id','before_data','after_data','timestamp','source']
};

/**
 * RUN THIS ONCE FROM THE APPS SCRIPT EDITOR.
 * It creates the Google Sheet database, all tabs, sample data and API key.
 */
function setupDemo() {
  var props = PropertiesService.getScriptProperties();
  var ss = getOrCreateDatabase_();
  ensureSheets_(ss);
  seedReferenceData_(ss);
  ensureTodayPjp_(ss, 'USR-NC001');
  seedDemoSubmissions_(ss);
  seedKpiTrend_(ss);

  var apiKey = props.getProperty(PROP_API_KEY);
  if (!apiKey) {
    apiKey = Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty(PROP_API_KEY, apiKey);
  }

  var result = {
    ok: true,
    message: 'Setup selesai. Simpan 2 nilai di bawah untuk Vercel.',
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId(),
    apiKey: apiKey
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


/** Run once after upgrading to V6 to authorize Drive and create the private evidence folder. */
function setupEvidenceStorage() {
  var folder = getOrCreateEvidenceFolder_();
  var result = {ok:true, message:'Evidence storage siap.', folderId:folder.getId(), folderName:folder.getName(), folderUrl:folder.getUrl()};
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Optional: run this before a pitch if you want fresh sample records. */
function resetPitchData() {
  var ss = getDatabase_();
  ['Submissions','StockTaking','Offtake','ValidationResults','CorrectionRequests','SubmissionVersions','AuditLogs','PJP','PJPVisits','VisitTasks','DailyNCKPI'].forEach(function(name) {
    clearDataKeepHeader_(ss.getSheetByName(name));
  });
  ensureTodayPjp_(ss, 'USR-NC001');
  seedDemoSubmissions_(ss);
  seedKpiTrend_(ss);
  Logger.log('Pitch data berhasil di-reset.');
}

function doGet() {
  return json_({
    ok: true,
    service: APP_NAME,
    message: 'GAS backend aktif. Aplikasi utama tetap dibuka dari Vercel.'
  });
}

function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }

    if (!verifyApiKey_(payload.apiKey)) {
      return json_({ok:false, error:'UNAUTHORIZED', message:'API key tidak cocok.'});
    }

    var action = String(payload.action || 'health');
    var writeActions = {submitStock:true, submitOfftake:true, submitVisualAudit:true, reviewVisualAudit:true, updateValidation:true};

    // Read-only actions must never wait behind a sheet write lock. This keeps
    // login, bootstrap and health responsive during a pitch or crowded field use.
    if (!writeActions[action]) {
      return json_(handleAction_(payload));
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) {
      return json_({ok:false, error:'BUSY', message:'Backend sedang sibuk. Data aman untuk di-retry dengan idempotency key.'});
    }

    try {
      return json_(handleAction_(payload));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({
      ok: false,
      error: 'SERVER_ERROR',
      message: err && err.message ? err.message : String(err)
    });
  }
}

function handleAction_(p) {
  var action = String(p.action || 'health');
  var ss = getDatabase_();

  // Sheet structure is created once by setupDemo(). Re-checking every tab on
  // every web request was the main source of 10–18 second latency in the demo.
  if (action === 'health') return health_(ss);
  if (action === 'login') return login_(ss, p);
  if (action === 'loginBootstrap') return loginBootstrap_(ss, p);
  if (action === 'bootstrap') return bootstrap_(ss, p);
  if (action === 'submitStock') return submitStock_(ss, p);
  if (action === 'submitOfftake') return submitOfftake_(ss, p);
  if (action === 'submitVisualAudit') return submitVisualAudit_(ss, p);
  if (action === 'getVisualAuditEvidence') return getVisualAuditEvidence_(ss, p);
  if (action === 'reviewVisualAudit') return reviewVisualAudit_(ss, p);
  if (action === 'listQueue') return listQueue_(ss, p);
  if (action === 'updateValidation') return updateValidation_(ss, p);

  return {ok:false, error:'UNKNOWN_ACTION', message:'Action tidak dikenal: ' + action};
}

function health_(ss) {
  return {
    ok: true,
    service: APP_NAME,
    database: ss.getName(),
    sheets: Object.keys(SHEETS).length,
    now: new Date().toISOString()
  };
}

function login_(ss, p) {
  var code = String(p.employeeCode || '').trim().toUpperCase();
  var pin = String(p.pin || '').trim();
  var user = findOne_(ss, 'Users', 'employee_code', code);
  if (!user || String(user.status) !== 'ACTIVE' || String(user.pin) !== pin) {
    return {ok:false, error:'LOGIN_FAILED', message:'Employee ID atau PIN salah.'};
  }
  audit_(ss, user.user_id, 'LOGIN', 'USER', user.user_id, '', '', 'VERCEL');
  return {ok:true, user:safeUser_(user)};
}

function loginBootstrap_(ss, p) {
  var code = String(p.employeeCode || '').trim().toUpperCase();
  var pin = String(p.pin || '').trim();
  var users = getRows_(ss, 'Users');
  var user = findInArray_(users, 'employee_code', code);
  if (!user || String(user.status) !== 'ACTIVE' || String(user.pin) !== pin) {
    return {ok:false, error:'LOGIN_FAILED', message:'Employee ID atau PIN salah.'};
  }
  // One network round-trip for pitch login. Avoid writing an audit row before
  // the page is usable; operational writes remain fully audited.
  return {ok:true, user:safeUser_(user), bootstrap:bootstrapFromUser_(ss, user, users)};
}

function bootstrap_(ss, p) {
  var users = getRows_(ss, 'Users');
  var user = findInArray_(users, 'user_id', String(p.userId || ''));
  if (!user) return {ok:false, error:'USER_NOT_FOUND', message:'User tidak ditemukan.'};
  return bootstrapFromUser_(ss, user, users);
}

function bootstrapFromUser_(ss, user, users) {
  if (user.role_id === 'NC') ensureTodayPjp_(ss, user.user_id);

  // Read each frequently-used sheet once. This replaces repeated full-sheet
  // reads from the v2/v3 bootstrap path and materially reduces GAS latency.
  var data = {
    users: users || getRows_(ss, 'Users'),
    stores: getRows_(ss, 'Stores'),
    products: getRows_(ss, 'Products'),
    submissions: getRows_(ss, 'Submissions'),
    kpi: getRows_(ss, 'DailyNCKPI'),
    regions: getRows_(ss, 'Regions'),
    pjps: getRows_(ss, 'PJP'),
    visits: getRows_(ss, 'PJPVisits'),
    versions: getRows_(ss, 'SubmissionVersions')
  };

  return {
    ok: true,
    user: safeUser_(user),
    stats: analyticsStatsFast_(data),
    trend: analyticsTrendFast_(data),
    regionPerformance: regionPerformanceFast_(data),
    tasks: user.role_id === 'NC' ? todayTasksFast_(data, user.user_id) : [],
    recentSubmissions: recentSubmissionsFast_(data, user, 8),
    queue: (user.role_id === 'DATA_ENTRY' || user.role_id === 'DATA_ANALYST' || user.role_id === 'PROJECT_MANAGER') ? queueRowsFast_(data, 20) : [],
    products: data.products.map(function(x){ return {productId:x.product_id, name:x.sku_name, brand:x.brand, category:x.category}; }),
    stores: data.stores.map(function(x){ return {storeId:x.store_id, name:x.store_name, channel:x.channel, regionId:x.region_id, areaId:x.area_id}; }),
    visualAudits: visualAuditRowsFast_(data, 12),
    system: {ok:true, service:APP_NAME, database:ss.getName(), sheets:Object.keys(SHEETS).length, now:new Date().toISOString()}
  };
}

function submitStock_(ss, p) {
  requireFields_(p, ['userId','storeId','productId','systemStock','physicalStock','idempotencyKey']);

  var existing = findOne_(ss, 'Submissions', 'idempotency_key', String(p.idempotencyKey));
  if (existing) {
    return {ok:true, duplicatePrevented:true, submission:existing, message:'Data sudah pernah diterima. Tidak dibuat duplikat.'};
  }

  var user = findOne_(ss, 'Users', 'user_id', String(p.userId));
  var store = findOne_(ss, 'Stores', 'store_id', String(p.storeId));
  var product = findOne_(ss, 'Products', 'product_id', String(p.productId));
  if (!user || !store || !product) return {ok:false, error:'MASTER_NOT_FOUND', message:'User, store, atau product tidak ditemukan.'};

  var systemStock = Number(p.systemStock);
  var physicalStock = Number(p.physicalStock);
  if (!isFinite(systemStock) || !isFinite(physicalStock) || systemStock < 0 || physicalStock < 0) {
    return {ok:false, error:'INVALID_STOCK', message:'Stock harus angka 0 atau lebih.'};
  }

  var gap = physicalStock - systemStock;
  var severity = Math.abs(gap) > 20 ? 'WARNING' : 'INFO';
  var validationStatus = severity === 'WARNING' ? 'WARNING' : 'VALIDATED';
  var submissionStatus = severity === 'WARNING' ? 'UNDER_REVIEW' : 'VALIDATED';
  var submissionId = 'SUB-' + Utilities.getUuid();
  var now = new Date().toISOString();

  appendObject_(ss, 'Submissions', {
    submission_id: submissionId,
    visit_id: String(p.visitId || ''),
    task_id: 'TASK-STOCK',
    user_id: user.user_id,
    store_id: store.store_id,
    submitted_at: now,
    device_timestamp: String(p.deviceTimestamp || now),
    server_timestamp: now,
    latitude: String(p.latitude || ''),
    longitude: String(p.longitude || ''),
    sync_source: String(p.syncSource || 'ONLINE'),
    submission_status: submissionStatus,
    validation_status: validationStatus,
    idempotency_key: String(p.idempotencyKey),
    version: 1
  });

  appendObject_(ss, 'StockTaking', {
    stock_id: 'STK-' + Utilities.getUuid(),
    submission_id: submissionId,
    product_id: product.product_id,
    system_stock: systemStock,
    physical_stock: physicalStock,
    stock_gap: gap,
    remark: String(p.remark || '')
  });

  appendObject_(ss, 'ValidationResults', {
    validation_id: 'VAL-' + Utilities.getUuid(),
    submission_id: submissionId,
    rule_id: 'STOCK_GAP',
    severity: severity,
    status: validationStatus,
    expected_value: 'Gap ideal <= 20 unit untuk demo',
    actual_value: gap,
    message: severity === 'WARNING' ? 'Gap stock besar. Perlu review Data Entry.' : 'Auto validation lulus.',
    validated_at: now
  });

  appendObject_(ss, 'SubmissionVersions', {
    submission_id: submissionId,
    version: 1,
    payload_snapshot: JSON.stringify({systemStock:systemStock, physicalStock:physicalStock, gap:gap, remark:String(p.remark || '')}),
    changed_by: user.user_id,
    changed_at: now,
    reason: 'ORIGINAL_SUBMISSION'
  });

  audit_(ss, user.user_id, 'CREATE', 'STOCK_SUBMISSION', submissionId, '', JSON.stringify({systemStock:systemStock,physicalStock:physicalStock,gap:gap}), 'VERCEL');

  return {
    ok: true,
    submissionId: submissionId,
    validationStatus: validationStatus,
    message: validationStatus === 'VALIDATED' ? 'Stock berhasil disimpan dan otomatis tervalidasi.' : 'Stock berhasil disimpan. Masuk antrean Data Entry karena ada warning.'
  };
}

function submitOfftake_(ss, p) {
  requireFields_(p, ['userId','storeId','productId','quantity','idempotencyKey']);

  var existing = findOne_(ss, 'Submissions', 'idempotency_key', String(p.idempotencyKey));
  if (existing) return {ok:true, duplicatePrevented:true, submission:existing, message:'Data sudah pernah diterima. Tidak dibuat duplikat.'};

  var user = findOne_(ss, 'Users', 'user_id', String(p.userId));
  var store = findOne_(ss, 'Stores', 'store_id', String(p.storeId));
  var product = findOne_(ss, 'Products', 'product_id', String(p.productId));
  if (!user || !store || !product) return {ok:false, error:'MASTER_NOT_FOUND', message:'User, store, atau product tidak ditemukan.'};

  var qty = Number(p.quantity);
  if (!isFinite(qty) || qty < 0) return {ok:false, error:'INVALID_QTY', message:'Quantity harus angka 0 atau lebih.'};

  var warning = qty > 60;
  var validationStatus = warning ? 'WARNING' : 'VALIDATED';
  var submissionId = 'SUB-' + Utilities.getUuid();
  var now = new Date().toISOString();

  appendObject_(ss, 'Submissions', {
    submission_id: submissionId,
    visit_id: String(p.visitId || ''),
    task_id: 'TASK-OFFTAKE',
    user_id: user.user_id,
    store_id: store.store_id,
    submitted_at: now,
    device_timestamp: String(p.deviceTimestamp || now),
    server_timestamp: now,
    latitude: String(p.latitude || ''),
    longitude: String(p.longitude || ''),
    sync_source: String(p.syncSource || 'ONLINE'),
    submission_status: warning ? 'UNDER_REVIEW' : 'VALIDATED',
    validation_status: validationStatus,
    idempotency_key: String(p.idempotencyKey),
    version: 1
  });

  appendObject_(ss, 'Offtake', {
    offtake_id: 'OFF-' + Utilities.getUuid(),
    submission_id: submissionId,
    product_id: product.product_id,
    quantity: qty,
    value: Number(p.value || 0),
    source: String(p.source || 'NC_INPUT'),
    period_start: String(p.periodStart || dateKey_(new Date())),
    period_end: String(p.periodEnd || dateKey_(new Date()))
  });

  appendObject_(ss, 'ValidationResults', {
    validation_id: 'VAL-' + Utilities.getUuid(),
    submission_id: submissionId,
    rule_id: 'OFFTAKE_OUTLIER',
    severity: warning ? 'WARNING' : 'INFO',
    status: validationStatus,
    expected_value: 'Demo threshold <= 60',
    actual_value: qty,
    message: warning ? 'Quantity tinggi untuk demo. Perlu review Data Entry.' : 'Auto validation lulus.',
    validated_at: now
  });

  appendObject_(ss, 'SubmissionVersions', {
    submission_id: submissionId,
    version: 1,
    payload_snapshot: JSON.stringify({quantity:qty, value:Number(p.value || 0)}),
    changed_by: user.user_id,
    changed_at: now,
    reason: 'ORIGINAL_SUBMISSION'
  });

  audit_(ss, user.user_id, 'CREATE', 'OFFTAKE_SUBMISSION', submissionId, '', JSON.stringify({quantity:qty}), 'VERCEL');
  return {ok:true, submissionId:submissionId, validationStatus:validationStatus, message: warning ? 'Offtake tersimpan dan masuk antrean review.' : 'Offtake tersimpan dan tervalidasi.'};
}

function submitVisualAudit_(ss, p) {
  requireFields_(p, ['userId','storeId','manualFacing','manualTotal','aiFacing','aiTotal','aiSos','idempotencyKey']);

  var existing = findOne_(ss, 'Submissions', 'idempotency_key', String(p.idempotencyKey));
  if (existing) return {ok:true, duplicatePrevented:true, submission:existing, message:'Visual audit sudah pernah diterima. Tidak dibuat duplikat.'};

  var user = findOne_(ss, 'Users', 'user_id', String(p.userId));
  var store = findOne_(ss, 'Stores', 'store_id', String(p.storeId));
  if (!user || !store) return {ok:false, error:'MASTER_NOT_FOUND', message:'User atau store tidak ditemukan.'};

  var manualFacing = Number(p.manualFacing), manualTotal = Number(p.manualTotal);
  var aiFacing = Number(p.aiFacing), aiTotal = Number(p.aiTotal), aiSos = Number(p.aiSos);
  var variance = Number(p.variance || (aiSos - (manualTotal ? manualFacing/manualTotal*100 : 0)));
  var absVar = Math.abs(variance);
  var validationStatus = absVar <= 3 ? 'VALIDATED' : (absVar <= 5 ? 'WARNING' : 'ERROR');
  var severity = validationStatus === 'VALIDATED' ? 'INFO' : validationStatus;
  var submissionId = 'SUB-' + Utilities.getUuid();
  var now = new Date().toISOString();
  var evidence = saveVisualEvidence_(p, submissionId, user, store);

  appendObject_(ss, 'Submissions', {
    submission_id:submissionId, visit_id:String(p.visitId || ''), task_id:'TASK-SOS', user_id:user.user_id, store_id:store.store_id,
    submitted_at:now, device_timestamp:String(p.deviceTimestamp || now), server_timestamp:now, latitude:String(p.latitude || ''), longitude:String(p.longitude || ''),
    sync_source:String(p.syncSource || 'ONLINE'), submission_status:validationStatus === 'VALIDATED' ? 'VALIDATED' : 'UNDER_REVIEW',
    validation_status:validationStatus, idempotency_key:String(p.idempotencyKey), version:1
  });

  var snapshot = {
    manual:{facing:manualFacing,total:manualTotal,sos:manualTotal ? Math.round(manualFacing/manualTotal*1000)/10 : 0},
    ai:{facing:aiFacing,total:aiTotal,sos:aiSos,confidence:Number(p.aiConfidence||0),osa:Number(p.osa||0),planogram:Number(p.planogram||0),posmDetected:Boolean(p.posmDetected),posmScore:Number(p.posmScore||0),ocrPrice:p.ocrPrice===''?'':Number(p.ocrPrice),ocrConfidence:Number(p.ocrConfidence||0)},
    comparison:{variance:variance,status:validationStatus},
    capture:{source:String(p.captureSource||'UNKNOWN'),width:Number(p.imageWidth||0),height:Number(p.imageHeight||0)},
    evidence:evidence,
    engine:'ON_DEVICE_REFERENCE_ASSISTED_CV_V6'
  };

  var rules = [
    ['AI_SOS', severity, validationStatus, 'Manual vs AI variance <= 3 pt', variance, 'AI Share of Shelf comparison'],
    ['AI_OSA', 'INFO', Number(p.osa||0) > 0 ? 'VALIDATED' : 'WARNING', 'SKU visible on shelf', Number(p.osa||0), 'On-shelf availability visual check'],
    ['AI_PLANOGRAM', 'INFO', Number(p.planogram||0) >= 70 ? 'VALIDATED' : 'WARNING', 'Planogram score >= 70%', Number(p.planogram||0), 'Detected shelf-position compliance'],
    ['AI_POSM', 'INFO', Boolean(p.posmDetected) ? 'VALIDATED' : 'WARNING', 'Paid visibility detected', Number(p.posmScore||0), 'POSM / paid visibility visual check'],
    ['AI_PRICE_OCR', 'INFO', p.ocrPrice!=='' ? 'VALIDATED' : 'WARNING', 'Readable price tag', String(p.ocrPrice||''), 'Local OCR price extraction']
  ];
  rules.forEach(function(r){ appendObject_(ss,'ValidationResults',{validation_id:'VAL-'+Utilities.getUuid(),submission_id:submissionId,rule_id:r[0],severity:r[1],status:r[2],expected_value:r[3],actual_value:r[4],message:r[5],validated_at:now}); });

  appendObject_(ss, 'SubmissionVersions', {submission_id:submissionId, version:1, payload_snapshot:JSON.stringify(snapshot), changed_by:user.user_id, changed_at:now, reason:'AI_VISUAL_AUDIT'});
  audit_(ss, user.user_id, 'CREATE', 'VISUAL_AUDIT', submissionId, '', JSON.stringify(snapshot), 'VERCEL');
  return {ok:true, submissionId:submissionId, validationStatus:validationStatus, evidenceStored:Boolean(evidence.originalFileId||evidence.annotatedFileId), message:validationStatus==='VALIDATED'?'Visual audit tersimpan dan tervalidasi.':'Visual audit tersimpan dan masuk exception queue.'};
}


function getOrCreateEvidenceFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_EVIDENCE_FOLDER_ID);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (ignore) {}
  }
  var folder = DriveApp.createFolder('NC2027_Pitch_Demo_Evidence');
  props.setProperty(PROP_EVIDENCE_FOLDER_ID, folder.getId());
  return folder;
}

function safeFilePart_(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'NA';
}

function dataUrlToBlob_(dataUrl, filename) {
  var text = String(dataUrl || '');
  var m = text.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Evidence image format invalid.');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 1200000) throw new Error('Evidence image terlalu besar setelah kompresi. Maksimum demo 1.2 MB per image.');
  return Utilities.newBlob(bytes, m[1], filename);
}

function saveVisualEvidence_(p, submissionId, user, store) {
  var result = {originalFileId:'', annotatedFileId:'', originalBytes:Number(p.evidenceOriginalBytes||0), annotatedBytes:Number(p.evidenceAnnotatedBytes||0)};
  var original = String(p.evidenceOriginalDataUrl || '');
  var annotated = String(p.evidenceAnnotatedDataUrl || '');
  if (!original && !annotated) return result;
  var folder = getOrCreateEvidenceFolder_();
  var prefix = safeFilePart_(submissionId) + '_' + safeFilePart_(user.employee_code || user.user_id) + '_' + safeFilePart_(store.store_code || store.store_id);
  var created = [];
  try {
    if (original) {
      var f1 = folder.createFile(dataUrlToBlob_(original, prefix + '_ORIGINAL.jpg'));
      created.push(f1); result.originalFileId = f1.getId(); result.originalBytes = f1.getSize();
    }
    if (annotated) {
      var f2 = folder.createFile(dataUrlToBlob_(annotated, prefix + '_AI_ANNOTATED.jpg'));
      created.push(f2); result.annotatedFileId = f2.getId(); result.annotatedBytes = f2.getSize();
    }
    return result;
  } catch (err) {
    created.forEach(function(f){ try { f.setTrashed(true); } catch(ignore){} });
    throw err;
  }
}

function findVisualAuditSnapshot_(ss, submissionId) {
  var rows = getRows_(ss, 'SubmissionVersions').filter(function(v){ return String(v.submission_id) === String(submissionId) && String(v.reason) === 'AI_VISUAL_AUDIT'; });
  if (!rows.length) return null;
  rows.sort(function(a,b){ return Number(b.version||0)-Number(a.version||0); });
  try { return JSON.parse(String(rows[0].payload_snapshot || '{}')); } catch (e) { return null; }
}

function fileToDataUrl_(fileId) {
  if (!fileId) return '';
  var blob = DriveApp.getFileById(String(fileId)).getBlob();
  return 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function getVisualAuditEvidence_(ss, p) {
  requireFields_(p, ['submissionId','userId']);
  var user = findOne_(ss, 'Users', 'user_id', String(p.userId));
  var submission = findOne_(ss, 'Submissions', 'submission_id', String(p.submissionId));
  if (!user || !submission) return {ok:false, error:'NOT_FOUND', message:'User atau visual audit tidak ditemukan.'};
  var role = String(user.role_id || '');
  var elevated = role === 'DATA_ENTRY' || role === 'DATA_ANALYST' || role === 'PROJECT_MANAGER' || role === 'CLIENT' || role === 'SUPER_ADMIN';
  if (!elevated && String(submission.user_id) !== String(user.user_id)) return {ok:false, error:'FORBIDDEN', message:'Anda tidak memiliki akses ke evidence ini.'};
  var snap = findVisualAuditSnapshot_(ss, p.submissionId);
  if (!snap) return {ok:false, error:'EVIDENCE_NOT_FOUND', message:'Snapshot visual audit tidak ditemukan.'};
  var ev = snap.evidence || {};
  var review = findLatestVisualReview_(ss, p.submissionId);
  return {
    ok:true,
    submissionId:String(p.submissionId),
    originalDataUrl:ev.originalFileId ? fileToDataUrl_(ev.originalFileId) : '',
    annotatedDataUrl:ev.annotatedFileId ? fileToDataUrl_(ev.annotatedFileId) : '',
    audit:{manual:snap.manual||{}, ai:snap.ai||{}, comparison:snap.comparison||{}, verified:review ? (review.verified||null) : null, review:review ? (review.review||null) : null, evidence:{available:Boolean(ev.originalFileId||ev.annotatedFileId)}, changedAt:String(submission.submitted_at||'')}
  };
}

function findLatestVisualReview_(ss, submissionId) {
  var rows = getRows_(ss, 'SubmissionVersions').filter(function(v){
    return String(v.submission_id) === String(submissionId) && String(v.reason) === 'VISUAL_AUDIT_REVIEW';
  });
  if (!rows.length) return null;
  rows.sort(function(a,b){ return Number(b.version||0) - Number(a.version||0); });
  try { return JSON.parse(String(rows[0].payload_snapshot || '{}')); } catch (e) { return null; }
}

function nextSubmissionVersion_(ss, submissionId) {
  var rows = getRows_(ss, 'SubmissionVersions').filter(function(v){ return String(v.submission_id) === String(submissionId); });
  var max = 0;
  rows.forEach(function(v){ max = Math.max(max, Number(v.version||0)); });
  return max + 1;
}

function reviewVisualAudit_(ss, p) {
  requireFields_(p, ['submissionId','userId','decision']);
  var user = findOne_(ss, 'Users', 'user_id', String(p.userId));
  var submission = findOne_(ss, 'Submissions', 'submission_id', String(p.submissionId));
  if (!user || !submission) return {ok:false, error:'NOT_FOUND', message:'Reviewer atau submission tidak ditemukan.'};
  var role = String(user.role_id || '');
  if (role !== 'DATA_ENTRY' && role !== 'PROJECT_MANAGER' && role !== 'SUPER_ADMIN') {
    return {ok:false, error:'FORBIDDEN', message:'Hanya Data Entry / Project Manager yang dapat menetapkan Verified Result.'};
  }
  if (String(submission.task_id) !== 'TASK-SOS') return {ok:false, error:'INVALID_TASK', message:'Submission ini bukan Visual Audit SOS.'};
  var snap = findVisualAuditSnapshot_(ss, p.submissionId);
  if (!snap) return {ok:false, error:'VISUAL_AUDIT_NOT_FOUND', message:'Snapshot Manual + AI tidak ditemukan.'};

  var decision = String(p.decision || '').toUpperCase();
  var manual = snap.manual || {}, ai = snap.ai || {}, verified = null;
  if (decision === 'ACCEPT_AI') {
    verified = {facing:Number(ai.facing||0), total:Number(ai.total||0), sos:Number(ai.sos||0), source:'AI'};
  } else if (decision === 'USE_MANUAL') {
    verified = {facing:Number(manual.facing||0), total:Number(manual.total||0), sos:Number(manual.sos||0), source:'MANUAL'};
  } else if (decision === 'OVERRIDE') {
    var facing = Number(p.overrideFacing), total = Number(p.overrideTotal);
    if (!isFinite(facing) || facing < 0 || !isFinite(total) || total <= 0 || facing > total) {
      return {ok:false, error:'INVALID_OVERRIDE', message:'Override facing/total tidak valid. Facing harus 0..total dan total > 0.'};
    }
    verified = {facing:facing, total:total, sos:Math.round((facing/total*100)*10)/10, source:'OVERRIDE'};
  } else {
    return {ok:false, error:'INVALID_DECISION', message:'Gunakan ACCEPT_AI, USE_MANUAL, atau OVERRIDE.'};
  }

  var now = new Date().toISOString();
  var version = nextSubmissionVersion_(ss, submission.submission_id);
  var review = {
    decision:decision,
    reason:String(p.reason || 'Visual evidence reviewed by Data Entry.'),
    reviewedBy:user.user_id,
    reviewerName:user.full_name,
    reviewedAt:now,
    previousValidation:String(submission.validation_status || '')
  };
  var payload = {verified:verified, review:review, manual:manual, ai:ai, comparison:snap.comparison||{}, engine:'VISUAL_REVIEW_V7'};

  updateRow_(ss, 'Submissions', 'submission_id', submission.submission_id, {
    submission_status:'VALIDATED', validation_status:'VALIDATED', version:version
  });
  appendObject_(ss, 'SubmissionVersions', {
    submission_id:submission.submission_id, version:version, payload_snapshot:JSON.stringify(payload), changed_by:user.user_id,
    changed_at:now, reason:'VISUAL_AUDIT_REVIEW'
  });
  appendObject_(ss, 'ValidationResults', {
    validation_id:'VAL-' + Utilities.getUuid(), submission_id:submission.submission_id, rule_id:'VISUAL_REVIEW', severity:'INFO', status:'VALIDATED',
    expected_value:'Reviewed final visual metric', actual_value:verified.source + ' SOS=' + verified.sos,
    message:review.reason, validated_at:now
  });
  audit_(ss, user.user_id, 'VISUAL_REVIEW_' + decision, 'VISUAL_AUDIT', submission.submission_id,
    JSON.stringify({manual:manual, ai:ai, comparison:snap.comparison||{}}), JSON.stringify({verified:verified, review:review}), 'VERCEL');
  return {ok:true, submissionId:submission.submission_id, verified:verified, review:review, message:'Verified Result tersimpan. Dashboard sekarang menggunakan hasil review sebagai nilai final visual audit.'};
}

function listQueue_(ss) {
  return {ok:true, queue:queueRows_(ss, 100)};
}

function updateValidation_(ss, p) {
  requireFields_(p, ['submissionId','userId','decision']);
  var submission = findOne_(ss, 'Submissions', 'submission_id', String(p.submissionId));
  if (!submission) return {ok:false, error:'NOT_FOUND', message:'Submission tidak ditemukan.'};

  var decision = String(p.decision).toUpperCase();
  var before = JSON.stringify({submission_status:submission.submission_status, validation_status:submission.validation_status});
  var now = new Date().toISOString();

  if (decision === 'VALIDATE') {
    updateRow_(ss, 'Submissions', 'submission_id', submission.submission_id, {
      submission_status: 'VALIDATED',
      validation_status: 'VALIDATED'
    });
    appendObject_(ss, 'ValidationResults', {
      validation_id: 'VAL-' + Utilities.getUuid(), submission_id: submission.submission_id,
      rule_id:'MANUAL_REVIEW', severity:'INFO', status:'VALIDATED', expected_value:'Manual review', actual_value:'APPROVED',
      message:String(p.reason || 'Approved by Data Entry'), validated_at:now
    });
  } else if (decision === 'CORRECTION') {
    updateRow_(ss, 'Submissions', 'submission_id', submission.submission_id, {
      submission_status: 'CORRECTION_REQUIRED',
      validation_status: 'CORRECTION_REQUIRED'
    });
    appendObject_(ss, 'CorrectionRequests', {
      correction_id:'COR-' + Utilities.getUuid(), submission_id:submission.submission_id,
      requested_by:String(p.userId), requested_at:now, reason:String(p.reason || 'Mohon cek kembali data.'),
      status:'OPEN', assigned_to:submission.user_id, resolved_at:''
    });
  } else {
    return {ok:false, error:'INVALID_DECISION', message:'Gunakan VALIDATE atau CORRECTION.'};
  }

  var after = JSON.stringify({decision:decision});
  audit_(ss, String(p.userId), decision === 'VALIDATE' ? 'VALIDATE' : 'REQUEST_CORRECTION', 'SUBMISSION', submission.submission_id, before, after, 'VERCEL');
  return {ok:true, message:decision === 'VALIDATE' ? 'Submission berhasil divalidasi.' : 'Permintaan koreksi berhasil dibuat.'};
}

function todayTasks_(ss, userId) {
  var visits = getRows_(ss, 'PJPVisits');
  var pjps = getRows_(ss, 'PJP');
  var stores = getRows_(ss, 'Stores');
  var today = dateKey_(new Date());
  var userPjpIds = {};
  pjps.forEach(function(x) { if (String(x.nc_id) === String(userId)) userPjpIds[String(x.pjp_id)] = true; });
  var result = [];
  visits.forEach(function(v) {
    if (userPjpIds[String(v.pjp_id)] && dateKey_(v.visit_date) === today) {
      var store = findInArray_(stores, 'store_id', v.store_id);
      result.push({
        visitId:v.pjp_visit_id,
        storeId:v.store_id,
        storeName:store ? store.store_name : v.store_id,
        plannedStart:v.planned_start,
        plannedEnd:v.planned_end,
        status:v.status,
        completion: v.status === 'COMPLETED' ? 100 : 45
      });
    }
  });
  return result;
}

function recentSubmissions_(ss, user, limit) {
  var subs = getRows_(ss, 'Submissions');
  var stores = getRows_(ss, 'Stores');
  var users = getRows_(ss, 'Users');
  if (user.role_id === 'NC') subs = subs.filter(function(x) { return String(x.user_id) === String(user.user_id); });
  subs.sort(function(a,b) { return String(b.submitted_at).localeCompare(String(a.submitted_at)); });
  return subs.slice(0, limit).map(function(s) {
    var store = findInArray_(stores, 'store_id', s.store_id);
    var owner = findInArray_(users, 'user_id', s.user_id);
    return {
      submissionId:s.submission_id,
      time:s.submitted_at,
      nc:owner ? owner.full_name : s.user_id,
      store:store ? store.store_name : s.store_id,
      task:taskName_(s.task_id),
      status:s.validation_status
    };
  });
}

function queueRows_(ss, limit) {
  var subs = getRows_(ss, 'Submissions').filter(function(s) {
    return ['WARNING','ERROR','CORRECTION_REQUIRED'].indexOf(String(s.validation_status)) >= 0;
  });
  var stores = getRows_(ss, 'Stores');
  var users = getRows_(ss, 'Users');
  subs.sort(function(a,b) { return String(b.submitted_at).localeCompare(String(a.submitted_at)); });
  return subs.slice(0, limit).map(function(s) {
    var store = findInArray_(stores, 'store_id', s.store_id);
    var user = findInArray_(users, 'user_id', s.user_id);
    return {
      submissionId:s.submission_id,
      time:s.submitted_at,
      nc:user ? user.full_name : s.user_id,
      store:store ? store.store_name : s.store_id,
      task:taskName_(s.task_id),
      validation:s.validation_status
    };
  });
}

function taskName_(taskId) {
  var map = {'TASK-STOCK':'Stock Taking','TASK-OFFTAKE':'Offtake','TASK-SOS':'SOS Visual Audit','TASK-PRICE':'Price Monitoring','TASK-COMP':'Competitor Monitoring'};
  return map[String(taskId)] || String(taskId || '');
}

function queueRowsFast_(data, limit) {
  var subs = data.submissions.filter(function(s){ return ['WARNING','ERROR','CORRECTION_REQUIRED'].indexOf(String(s.validation_status)) >= 0; });
  subs.sort(function(a,b){ return String(b.submitted_at).localeCompare(String(a.submitted_at)); });
  return subs.slice(0, limit).map(function(s){
    var store=findInArray_(data.stores,'store_id',s.store_id), user=findInArray_(data.users,'user_id',s.user_id);
    return {submissionId:s.submission_id,time:s.submitted_at,nc:user?user.full_name:s.user_id,store:store?store.store_name:s.store_id,task:taskName_(s.task_id),validation:s.validation_status};
  });
}

function analyticsStatsFast_(data) {
  var activeNc=data.users.filter(function(u){return u.role_id==='NC'&&u.status==='ACTIVE';}).length;
  var activeStores=data.stores.filter(function(s){return s.status==='ACTIVE';}).length;
  var validated=data.submissions.filter(function(s){return s.validation_status==='VALIDATED';}).length;
  var total=data.submissions.length||1, accuracy=Math.round(validated/total*1000)/10, today=dateKey_(new Date());
  function metric(k,f){var rows=data.kpi.filter(function(x){return dateKey_(x.date)===today&&x.kpi_id===k;});if(!rows.length)return f;var sum=0;rows.forEach(function(r){sum+=Number(r.actual||0);});return Math.round(sum*10)/10;}
  return {activeNC:activeNc,activeStores:activeStores,storeCoverage:Math.min(100,74+Math.min(22,data.submissions.length)),taskCompletion:Math.min(100,78+Math.min(18,Math.floor(data.submissions.length/2))),acquisition:metric('ACQUISITION',186),conversion:metric('CONVERSION',68),offtake:metric('OFFTAKE_PCT',92),gwpAbsorption:metric('GWP_ABSORPTION',87),dataAccuracy:isFinite(accuracy)?accuracy:99.2,totalSubmissions:data.submissions.length,pendingReview:queueRowsFast_(data,1000).length};
}
function analyticsTrendFast_(data){var by={};data.kpi.filter(function(x){return x.kpi_id==='ACQUISITION';}).forEach(function(r){var d=dateKey_(r.date);by[d]=(by[d]||0)+Number(r.actual||0);});return Object.keys(by).sort().slice(-7).map(function(d){return{date:d,value:Math.round(by[d])};});}
function regionPerformanceFast_(data){var rows=data.kpi.filter(function(x){return x.kpi_id==='ACQUISITION';}),latest='';rows.forEach(function(r){var d=dateKey_(r.date);if(d>latest)latest=d;});return data.regions.map(function(region){var rr=rows.filter(function(x){return String(x.region_id)===String(region.region_id)&&dateKey_(x.date)===latest;}),target=0,actual=0;rr.forEach(function(x){target+=Number(x.target||0);actual+=Number(x.actual||0);});return{region:region.region_name,target:Math.round(target),actual:Math.round(actual),achievement:target?Math.round(actual/target*1000)/10:0};});}
function todayTasksFast_(data,userId){var today=dateKey_(new Date()),ids={};data.pjps.forEach(function(x){if(String(x.nc_id)===String(userId))ids[String(x.pjp_id)]=true;});var out=[];data.visits.forEach(function(v){if(ids[String(v.pjp_id)]&&dateKey_(v.visit_date)===today){var store=findInArray_(data.stores,'store_id',v.store_id);out.push({visitId:v.pjp_visit_id,storeId:v.store_id,storeName:store?store.store_name:v.store_id,plannedStart:v.planned_start,plannedEnd:v.planned_end,status:v.status,completion:v.status==='COMPLETED'?100:(v.status==='IN_PROGRESS'?65:0)});}});return out;}
function recentSubmissionsFast_(data,user,limit){var subs=data.submissions.slice();if(user.role_id==='NC')subs=subs.filter(function(x){return String(x.user_id)===String(user.user_id);});subs.sort(function(a,b){return String(b.submitted_at).localeCompare(String(a.submitted_at));});return subs.slice(0,limit).map(function(s){var store=findInArray_(data.stores,'store_id',s.store_id),owner=findInArray_(data.users,'user_id',s.user_id);return{submissionId:s.submission_id,time:s.submitted_at,nc:owner?owner.full_name:s.user_id,store:store?store.store_name:s.store_id,task:taskName_(s.task_id),status:s.validation_status};});}
function visualAuditRowsFast_(data,limit){
  var ids={}, reviews={};
  data.submissions.forEach(function(s){ if(String(s.task_id)==='TASK-SOS') ids[String(s.submission_id)] = s; });
  data.versions.forEach(function(v){
    if (!ids[String(v.submission_id)] || String(v.reason)!=='VISUAL_AUDIT_REVIEW') return;
    try {
      var p=JSON.parse(String(v.payload_snapshot||'{}')), key=String(v.submission_id), current=reviews[key];
      if (!current || Number(v.version||0) > Number(current.version||0)) reviews[key]={version:Number(v.version||0), payload:p};
    } catch(ignore) {}
  });
  var out=[];
  data.versions.forEach(function(v){
    var sid=String(v.submission_id), sub=ids[sid];
    if(!sub || String(v.reason)!=='AI_VISUAL_AUDIT') return;
    try{
      var p=JSON.parse(String(v.payload_snapshot||'{}')), ev=p.evidence||{}, rv=reviews[sid]&&reviews[sid].payload||null;
      var store=findInArray_(data.stores,'store_id',sub.store_id), owner=findInArray_(data.users,'user_id',sub.user_id);
      out.push({submissionId:sid,changedAt:v.changed_at,nc:owner?owner.full_name:sub.user_id,store:store?store.store_name:sub.store_id,manual:p.manual||{},ai:p.ai||{},comparison:p.comparison||{},verified:rv?(rv.verified||null):null,review:rv?(rv.review||null):null,evidence:{available:Boolean(ev.originalFileId||ev.annotatedFileId),originalStored:Boolean(ev.originalFileId),annotatedStored:Boolean(ev.annotatedFileId),captureSource:(p.capture&&p.capture.source)||''}});
    }catch(ignore){}
  });
  out.sort(function(a,b){return String(b.changedAt).localeCompare(String(a.changedAt));});
  return out.slice(0,limit);
}

function analyticsStats_(ss) {
  var users = getRows_(ss, 'Users');
  var stores = getRows_(ss, 'Stores');
  var subs = getRows_(ss, 'Submissions');
  var kpi = getRows_(ss, 'DailyNCKPI');
  var today = dateKey_(new Date());

  var activeNc = users.filter(function(u) { return u.role_id === 'NC' && u.status === 'ACTIVE'; }).length;
  var activeStores = stores.filter(function(s) { return s.status === 'ACTIVE'; }).length;
  var validated = subs.filter(function(s) { return s.validation_status === 'VALIDATED'; }).length;
  var total = subs.length || 1;
  var accuracy = Math.round((validated / total) * 1000) / 10;

  function todayMetric(metric, fallback) {
    var rows = kpi.filter(function(x) { return dateKey_(x.date) === today && x.kpi_id === metric; });
    if (!rows.length) return fallback;
    var sum = 0;
    rows.forEach(function(r) { sum += Number(r.actual || 0); });
    return Math.round(sum * 10) / 10;
  }

  return {
    activeNC: activeNc,
    activeStores: activeStores,
    storeCoverage: Math.min(100, 74 + Math.min(22, subs.length)),
    taskCompletion: Math.min(100, 78 + Math.min(18, Math.floor(subs.length / 2))),
    acquisition: todayMetric('ACQUISITION', 186),
    conversion: todayMetric('CONVERSION', 68),
    offtake: todayMetric('OFFTAKE_PCT', 92),
    gwpAbsorption: todayMetric('GWP_ABSORPTION', 87),
    dataAccuracy: isFinite(accuracy) ? accuracy : 99.2,
    totalSubmissions: subs.length,
    pendingReview: queueRows_(ss, 1000).length
  };
}

function analyticsTrend_(ss) {
  var rows = getRows_(ss, 'DailyNCKPI').filter(function(x) { return x.kpi_id === 'ACQUISITION'; });
  var byDate = {};
  rows.forEach(function(r) {
    var d = dateKey_(r.date);
    byDate[d] = (byDate[d] || 0) + Number(r.actual || 0);
  });
  return Object.keys(byDate).sort().slice(-7).map(function(d) { return {date:d, value:Math.round(byDate[d])}; });
}

function regionPerformance_(ss) {
  var regions = getRows_(ss, 'Regions');
  var rows = getRows_(ss, 'DailyNCKPI').filter(function(x) { return x.kpi_id === 'ACQUISITION'; });
  var latestDate = '';
  rows.forEach(function(r) { var d = dateKey_(r.date); if (d > latestDate) latestDate = d; });
  return regions.map(function(region) {
    var r = rows.filter(function(x) { return String(x.region_id) === String(region.region_id) && dateKey_(x.date) === latestDate; });
    var target = 0, actual = 0;
    r.forEach(function(x) { target += Number(x.target || 0); actual += Number(x.actual || 0); });
    return {
      region: region.region_name,
      target: Math.round(target),
      actual: Math.round(actual),
      achievement: target ? Math.round((actual / target) * 1000) / 10 : 0
    };
  });
}

function getOrCreateDatabase_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_DB_ID);
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (ignore) {}
  }
  var ss = SpreadsheetApp.create('NC 2027 Pitch Demo Database');
  props.setProperty(PROP_DB_ID, ss.getId());
  return ss;
}

function getDatabase_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_DB_ID);
  if (!id) throw new Error('Database belum dibuat. Jalankan setupDemo() sekali dari Apps Script editor.');
  return SpreadsheetApp.openById(id);
}

function verifyApiKey_(provided) {
  var expected = PropertiesService.getScriptProperties().getProperty(PROP_API_KEY);
  return expected && String(provided || '') === String(expected);
}

function ensureSheets_(ss) {
  Object.keys(SHEETS).forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = SHEETS[name];
    var existing = sheet.getLastColumn() ? sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0] : [];
    var needHeader = sheet.getLastRow() === 0 || String(existing[0] || '') !== String(headers[0]);
    if (needHeader) {
      sheet.clear();
      sheet.getRange(1,1,1,headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && Object.keys(SHEETS).indexOf('Sheet1') === -1 && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
}

function seedReferenceData_(ss) {
  seedIfEmpty_(ss, 'Regions', [
    {region_id:'REG-JBD',region_code:'JBD',region_name:'Jabodetabek',status:'ACTIVE'},
    {region_id:'REG-WJ',region_code:'WJ',region_name:'West Java',status:'ACTIVE'},
    {region_id:'REG-CJ',region_code:'CJ',region_name:'Central Java',status:'ACTIVE'}
  ]);

  seedIfEmpty_(ss, 'Areas', [
    {area_id:'AREA-JKS',region_id:'REG-JBD',area_code:'JKS',area_name:'Jakarta Selatan',status:'ACTIVE'},
    {area_id:'AREA-BDG',region_id:'REG-WJ',area_code:'BDG',area_name:'Bandung',status:'ACTIVE'},
    {area_id:'AREA-SMG',region_id:'REG-CJ',area_code:'SMG',area_name:'Semarang',status:'ACTIVE'}
  ]);

  seedIfEmpty_(ss, 'Users', [
    {user_id:'USR-NC001',employee_code:'NC001',full_name:'Mimo',role_id:'NC',phone:'081200000001',email:'mimo@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-NC002',employee_code:'NC002',full_name:'Sari Putri',role_id:'NC',phone:'081200000002',email:'sari@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-NC003',employee_code:'NC003',full_name:'Dinda Ayu',role_id:'NC',phone:'081200000003',email:'dinda@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-NC004',employee_code:'NC004',full_name:'Rani Dewi',role_id:'NC',phone:'081200000004',email:'rani@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-DE001',employee_code:'DE001',full_name:'Admin Data',role_id:'DATA_ENTRY',phone:'081200000010',email:'dataentry@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-DA001',employee_code:'DA001',full_name:'Data Analyst',role_id:'DATA_ANALYST',phone:'081200000011',email:'analyst@example.com',status:'ACTIVE',pin:'1234'},
    {user_id:'USR-PM001',employee_code:'PM001',full_name:'Project Manager',role_id:'PROJECT_MANAGER',phone:'081200000012',email:'pm@example.com',status:'ACTIVE',pin:'1234'}
  ]);

  seedIfEmpty_(ss, 'Assignments', [
    {assignment_id:'ASG-1',user_id:'USR-NC001',supervisor_id:'TL-JKS',region_id:'REG-JBD',area_id:'AREA-JKS',effective_start:'2027-01-01',effective_end:''},
    {assignment_id:'ASG-2',user_id:'USR-NC002',supervisor_id:'TL-JKS',region_id:'REG-JBD',area_id:'AREA-JKS',effective_start:'2027-01-01',effective_end:''},
    {assignment_id:'ASG-3',user_id:'USR-NC003',supervisor_id:'TL-BDG',region_id:'REG-WJ',area_id:'AREA-BDG',effective_start:'2027-01-01',effective_end:''},
    {assignment_id:'ASG-4',user_id:'USR-NC004',supervisor_id:'TL-SMG',region_id:'REG-CJ',area_id:'AREA-SMG',effective_start:'2027-01-01',effective_end:''}
  ]);

  seedIfEmpty_(ss, 'Stores', [
    {store_id:'STR-JKS-001',store_code:'JKS001',store_name:'Baby Shop Kemang',channel:'Baby Store',region_id:'REG-JBD',area_id:'AREA-JKS',address:'Kemang, Jakarta Selatan',city:'Jakarta',latitude:-6.2615,longitude:106.8106,gps_radius:200,status:'ACTIVE'},
    {store_id:'STR-JKS-002',store_code:'JKS002',store_name:'Mothercare Demo Mall',channel:'Modern Trade',region_id:'REG-JBD',area_id:'AREA-JKS',address:'Jakarta Selatan',city:'Jakarta',latitude:-6.2441,longitude:106.8005,gps_radius:200,status:'ACTIVE'},
    {store_id:'STR-JKS-003',store_code:'JKS003',store_name:'Kids Corner Cilandak',channel:'Baby Store',region_id:'REG-JBD',area_id:'AREA-JKS',address:'Cilandak, Jakarta Selatan',city:'Jakarta',latitude:-6.2897,longitude:106.7994,gps_radius:200,status:'ACTIVE'},
    {store_id:'STR-BDG-001',store_code:'BDG001',store_name:'Baby House Bandung',channel:'Baby Store',region_id:'REG-WJ',area_id:'AREA-BDG',address:'Bandung',city:'Bandung',latitude:-6.9175,longitude:107.6191,gps_radius:200,status:'ACTIVE'},
    {store_id:'STR-BDG-002',store_code:'BDG002',store_name:'Family Mart Demo Bandung',channel:'Modern Trade',region_id:'REG-WJ',area_id:'AREA-BDG',address:'Bandung',city:'Bandung',latitude:-6.9147,longitude:107.6098,gps_radius:200,status:'ACTIVE'},
    {store_id:'STR-SMG-001',store_code:'SMG001',store_name:'Little Star Semarang',channel:'Baby Store',region_id:'REG-CJ',area_id:'AREA-SMG',address:'Semarang',city:'Semarang',latitude:-6.9667,longitude:110.4167,gps_radius:200,status:'ACTIVE'}
  ]);

  seedIfEmpty_(ss, 'Products', [
    {product_id:'PRD-EFA-400',brand:'Enfagrow A+',category:'Growing Up Milk',sku_code:'EFA400',sku_name:'Enfagrow A+ 400g',size:'400g',uom:'CAN',status:'ACTIVE'},
    {product_id:'PRD-EFA-800',brand:'Enfagrow A+',category:'Growing Up Milk',sku_code:'EFA800',sku_name:'Enfagrow A+ 800g',size:'800g',uom:'CAN',status:'ACTIVE'},
    {product_id:'PRD-EFA-1200',brand:'Enfagrow A+',category:'Growing Up Milk',sku_code:'EFA1200',sku_name:'Enfagrow A+ 1200g',size:'1200g',uom:'CAN',status:'ACTIVE'}
  ]);

  seedIfEmpty_(ss, 'TaskDefinitions', [
    {task_id:'TASK-STOCK',task_code:'STOCK_TAKING',task_name:'Stock Taking',frequency:'DAILY',required:true,requires_photo:false,requires_gps:true,status:'ACTIVE'},
    {task_id:'TASK-OFFTAKE',task_code:'OFFTAKE',task_name:'Offtake',frequency:'DAILY',required:true,requires_photo:false,requires_gps:true,status:'ACTIVE'},
    {task_id:'TASK-SOS',task_code:'SOS',task_name:'Share of Shelf',frequency:'BI_WEEKLY',required:false,requires_photo:true,requires_gps:true,status:'ACTIVE'},
    {task_id:'TASK-PRICE',task_code:'PRICE_MONITORING',task_name:'Price Monitoring',frequency:'BI_WEEKLY',required:false,requires_photo:true,requires_gps:true,status:'ACTIVE'},
    {task_id:'TASK-COMP',task_code:'COMPETITOR',task_name:'Competitor Monitoring',frequency:'BI_WEEKLY',required:false,requires_photo:true,requires_gps:true,status:'ACTIVE'}
  ]);
}

function ensureTodayPjp_(ss, userId) {
  var today = dateKey_(new Date());
  var pjpId = 'PJP-' + userId + '-' + today;
  if (!findOne_(ss, 'PJP', 'pjp_id', pjpId)) {
    appendObject_(ss, 'PJP', {pjp_id:pjpId,period:today,nc_id:userId,status:'ACTIVE',created_by:'SYSTEM',created_at:new Date().toISOString()});
  }
  var existingVisits = getRows_(ss, 'PJPVisits').filter(function(v) { return String(v.pjp_id) === pjpId; });
  if (!existingVisits.length) {
    var stores = ['STR-JKS-001','STR-JKS-002','STR-JKS-003'];
    var times = [['09:00','11:00'],['11:30','13:30'],['14:00','16:00']];
    stores.forEach(function(storeId, i) {
      appendObject_(ss, 'PJPVisits', {
        pjp_visit_id:'VIS-' + Utilities.getUuid(), pjp_id:pjpId, visit_date:today, store_id:storeId,
        sequence:i+1, planned_start:times[i][0], planned_end:times[i][1], status:i === 0 ? 'IN_PROGRESS' : 'PLANNED'
      });
    });
  }
}

function seedDemoSubmissions_(ss) {
  if (getRows_(ss, 'Submissions').length) return;
  var now = new Date();
  var samples = [
    {u:'USR-NC001',s:'STR-JKS-001',task:'TASK-STOCK',status:'VALIDATED',mins:20},
    {u:'USR-NC002',s:'STR-JKS-002',task:'TASK-OFFTAKE',status:'VALIDATED',mins:31},
    {u:'USR-NC003',s:'STR-BDG-001',task:'TASK-STOCK',status:'WARNING',mins:42},
    {u:'USR-NC004',s:'STR-SMG-001',task:'TASK-OFFTAKE',status:'CORRECTION_REQUIRED',mins:55},
    {u:'USR-NC001',s:'STR-JKS-002',task:'TASK-OFFTAKE',status:'VALIDATED',mins:68},
    {u:'USR-NC003',s:'STR-BDG-002',task:'TASK-STOCK',status:'VALIDATED',mins:80}
  ];
  samples.forEach(function(x, idx) {
    var id = 'SUB-DEMO-' + (idx + 1);
    var t = new Date(now.getTime() - x.mins * 60000).toISOString();
    appendObject_(ss, 'Submissions', {
      submission_id:id, visit_id:'', task_id:x.task, user_id:x.u, store_id:x.s, submitted_at:t,
      device_timestamp:t, server_timestamp:t, latitude:'', longitude:'', sync_source:'ONLINE',
      submission_status:x.status === 'VALIDATED' ? 'VALIDATED' : (x.status === 'CORRECTION_REQUIRED' ? 'CORRECTION_REQUIRED' : 'UNDER_REVIEW'),
      validation_status:x.status, idempotency_key:'DEMO-' + idx, version:1
    });
    if (x.task === 'TASK-STOCK') appendObject_(ss, 'StockTaking', {stock_id:'STK-DEMO-' + idx,submission_id:id,product_id:'PRD-EFA-400',system_stock:40,physical_stock:x.status === 'WARNING' ? 8 : 38,stock_gap:x.status === 'WARNING' ? -32 : -2,remark:'Demo data'});
    if (x.task === 'TASK-OFFTAKE') appendObject_(ss, 'Offtake', {offtake_id:'OFF-DEMO-' + idx,submission_id:id,product_id:'PRD-EFA-800',quantity:x.status === 'CORRECTION_REQUIRED' ? 75 : 18,value:0,source:'NC_INPUT',period_start:dateKey_(now),period_end:dateKey_(now)});
  });
}

function seedKpiTrend_(ss) {
  if (getRows_(ss, 'DailyNCKPI').length) return;
  var regions = ['REG-JBD','REG-WJ','REG-CJ'];
  var multipliers = [1.15, 0.98, 0.86];
  for (var d = 6; d >= 0; d--) {
    var date = new Date();
    date.setDate(date.getDate() - d);
    var dk = dateKey_(date);
    regions.forEach(function(region, idx) {
      var base = 52 + (6 - d) * 4 + idx * 3;
      var actual = Math.round(base * multipliers[idx]);
      var target = 60 + idx * 5;
      appendObject_(ss, 'DailyNCKPI', {date:dk,region_id:region,kpi_id:'ACQUISITION',target:target,actual:actual,achievement:Math.round(actual/target*1000)/10});
      appendObject_(ss, 'DailyNCKPI', {date:dk,region_id:region,kpi_id:'CONVERSION',target:25,actual:Math.round(actual*0.36),achievement:Math.round((actual*0.36)/25*1000)/10});
      appendObject_(ss, 'DailyNCKPI', {date:dk,region_id:region,kpi_id:'OFFTAKE_PCT',target:100,actual:90 + idx + ((6-d)%3),achievement:90 + idx + ((6-d)%3)});
      appendObject_(ss, 'DailyNCKPI', {date:dk,region_id:region,kpi_id:'GWP_ABSORPTION',target:100,actual:84 + idx*2 + ((6-d)%4),achievement:84 + idx*2 + ((6-d)%4)});
    });
  }
}

function safeUser_(u) {
  return {userId:u.user_id, employeeCode:u.employee_code, fullName:u.full_name, role:u.role_id, status:u.status};
}

function getRows_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    if (values[r].join('') === '') continue;
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = values[r][i]; });
    rows.push(obj);
  }
  return rows;
}

function appendObject_(ss, sheetName, obj) {
  var sheet = ss.getSheetByName(sheetName);
  var headers = SHEETS[sheetName];
  var row = headers.map(function(h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.appendRow(row);
}

function findOne_(ss, sheetName, field, value) {
  return findInArray_(getRows_(ss, sheetName), field, value);
}

function findInArray_(rows, field, value) {
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][field]) === String(value)) return rows[i];
  }
  return null;
}

function updateRow_(ss, sheetName, idField, idValue, updates) {
  var sheet = ss.getSheetByName(sheetName);
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(String);
  var idIndex = headers.indexOf(idField);
  if (idIndex < 0) throw new Error('ID field tidak ditemukan: ' + idField);
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idIndex]) === String(idValue)) {
      Object.keys(updates).forEach(function(k) {
        var c = headers.indexOf(k);
        if (c >= 0) sheet.getRange(r + 1, c + 1).setValue(updates[k]);
      });
      return true;
    }
  }
  return false;
}

function seedIfEmpty_(ss, sheetName, rows) {
  if (getRows_(ss, sheetName).length) return;
  rows.forEach(function(r) { appendObject_(ss, sheetName, r); });
}

function clearDataKeepHeader_(sheet) {
  if (!sheet) return;
  if (sheet.getLastRow() > 1) sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getMaxColumns()).clearContent();
}

function requireFields_(obj, fields) {
  fields.forEach(function(f) {
    if (obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '') throw new Error('Field wajib belum diisi: ' + f);
  });
}

function audit_(ss, actorId, action, entityType, entityId, beforeData, afterData, source) {
  appendObject_(ss, 'AuditLogs', {
    audit_id:'AUD-' + Utilities.getUuid(), actor_id:actorId, action:action, entity_type:entityType, entity_id:entityId,
    before_data:beforeData, after_data:afterData, timestamp:new Date().toISOString(), source:source
  });
}

function dateKey_(value) {
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value || '').substring(0,10);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
