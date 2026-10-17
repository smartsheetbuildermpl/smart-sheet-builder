export const uploadProfileTemplates = [
  { key: 'dtf', name: 'DTF 24″ Gang Sheet', machine: 'dtf', widthIn: 23, lengthIn: 39 },
  { key: 'uvdtf24', name: 'UV-DTF 24″ Gang Sheet', machine: 'uvdtf24', widthIn: 23, lengthIn: 39 },
  { key: 'uvdtf12', name: 'UV-DTF 12″ Gang Sheet', machine: 'uvdtf12', widthIn: 11, lengthIn: 39 },
  { key: 'tarpaulin', name: 'Tarpaulin', machine: 'tarpaulin', widthIn: 63, lengthIn: 39, dpi: 150 }
];
export const machineLabel = machine => ({ dtf: 'DTF 24″', uvdtf24: 'UV-DTF 24″', uvdtf12: 'UV-DTF 12″', tarpaulin: 'Tarpaulin' })[machine] || 'Legacy';
