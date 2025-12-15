// diff.js - utilities for computing diffs between setupData objects
// Exports:
//   diffObjects(a, b, options) => Array<{ path, group, label, aValue, bValue, changed, changeType }>
//   prettyLabelFromPath(path) => human-readable label for a dot-delimited path

const labelMap = {
  'chassis.rideHeightF': 'Ride Height (Front)',
  'chassis.rideHeightR': 'Ride Height (Rear)',
  'chassis.droopF': 'Droop (Front)',
  'chassis.droopR': 'Droop (Rear)',
  'chassis.weightBalanceNotes': 'Weight Balance',

  'suspension.springsF': 'Springs (Front)',
  'suspension.springsR': 'Springs (Rear)',
  'suspension.pistonsF': 'Pistons (Front)',
  'suspension.pistonsR': 'Pistons (Rear)',
  'suspension.shockOilF': 'Shock Oil (Front)',
  'suspension.shockOilR': 'Shock Oil (Rear)',
  'suspension.shockPosF': 'Shock Position (Front)',
  'suspension.shockPosR': 'Shock Position (Rear)',
  'suspension.camberF': 'Camber (Front)',
  'suspension.camberR': 'Camber (Rear)',
  'suspension.toeF': 'Toe (Front)',
  'suspension.toeR': 'Toe (Rear)',

  'drivetrain.pinion': 'Pinion',
  'drivetrain.spur': 'Spur',
  'drivetrain.fdrNotes': 'FDR Notes',
  'drivetrain.diffType': 'Diff Type',
  'drivetrain.diffOilF': 'Diff Oil (Front)',
  'drivetrain.diffOilR': 'Diff Oil (Rear)',
  'drivetrain.centerDiffOil': 'Center Diff Oil',

  'tires.tireBrand': 'Tire Brand',
  'tires.tireCompound': 'Tire Compound',
  'tires.insert': 'Insert',
  'tires.sauce': 'Sauce',
  'tires.prepNotes': 'Prep Notes',

  'electronics.escProfile': 'ESC Profile',
  'electronics.timing': 'Timing',
  'electronics.punch': 'Punch',
  'electronics.motorNotes': 'Motor Notes',

  'general.trackCondition': 'Track Condition',
  'general.temp': 'Temperature',
  'general.notes': 'Notes'
};

function isPlainObject(val) {
  return Object.prototype.toString.call(val) === '[object Object]';
}

function normalizeValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  return val;
}

function isEmpty(val) {
  return val === '' || val === null || val === undefined;
}

function prettyLabelFromPath(path) {
  if (!path) return '';
  if (labelMap[path]) return labelMap[path];

  const parts = path.split('.');
  const key = parts[parts.length - 1];

  // Detect trailing F/R to annotate Front/Rear
  const frMatch = key.match(/^(.*?)([FR])$/);
  const baseKey = frMatch ? frMatch[1] : key;
  const suffix = frMatch ? (frMatch[2] === 'F' ? ' (Front)' : ' (Rear)') : '';

  const spaced = baseKey
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();

  const words = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return `${words}${suffix}`;
}

function diffObjects(a, b, options = {}) {
  const ignorePaths = Array.isArray(options.ignorePaths) ? options.ignorePaths : [];
  const rows = [];

  const visit = (valA, valB, prefix = '') => {
    const isObjA = isPlainObject(valA);
    const isObjB = isPlainObject(valB);

    // If both are objects, traverse keys
    if (isObjA || isObjB) {
      const keys = new Set([
        ...Object.keys(isObjA ? valA : {}),
        ...Object.keys(isObjB ? valB : {})
      ]);

      for (const key of keys) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (ignorePaths.includes(path)) continue;
        visit(isObjA ? valA[key] : undefined, isObjB ? valB[key] : undefined, path);
      }
      return;
    }

    // Leaf comparison
    const normA = normalizeValue(valA);
    const normB = normalizeValue(valB);
    const emptyA = isEmpty(normA);
    const emptyB = isEmpty(normB);

    let changeType = 'same';
    if (emptyA && !emptyB) {
      changeType = 'added';
    } else if (!emptyA && emptyB) {
      changeType = 'removed';
    } else if (!emptyA && !emptyB && normA !== normB) {
      changeType = 'modified';
    }

    rows.push({
      path: prefix,
      group: prefix.split('.')[0] || '',
      label: prettyLabelFromPath(prefix),
      aValue: normA,
      bValue: normB,
      changed: changeType !== 'same',
      changeType
    });
  };

  visit(a || {}, b || {}, '');

  // Remove the synthetic root row if created (empty path)
  return rows.filter(r => r.path);
}

export { diffObjects, prettyLabelFromPath };
