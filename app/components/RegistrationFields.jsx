'use client';

export const emptyRegistration = { full_name: '', business_name: '', mobile: '', city: '', country: '', machine_type: '', monthly_usage: '', terms_accepted: false };
export default function RegistrationFields({ value, onChange, registration = true }) {
  const field = (key, label, maxLength, autoComplete) => <label key={key}>{label}<input value={value[key] || ''} maxLength={maxLength} autoComplete={autoComplete} required={key === 'full_name'} onChange={e => onChange({ ...value, [key]: e.target.value })} /></label>;
  return <>
    {field('full_name', 'Full name', 120, 'name')}
    <details className="registration-optional"><summary>Business & printing details (optional)</summary>
      {field('business_name', 'Business / shop name', 160, 'organization')}
      {field('mobile', 'Mobile number', 40, 'tel')}
      <div className="registration-columns">{field('city', 'City', 100, 'address-level2')}{field('country', 'Country', 100, 'country-name')}</div>
      <label>Printing use / machine type<select value={value.machine_type || ''} onChange={e => onChange({ ...value, machine_type: e.target.value })}><option value="">Choose (optional)</option>{['DTF', 'UV-DTF', 'Tarpaulin', 'Other'].map(type => <option key={type}>{type}</option>)}</select></label>
      {field('monthly_usage', 'Estimated monthly usage (e.g. 20 sheets)', 100, 'off')}
      {registration && <label className="registration-consent"><input type="checkbox" checked={value.terms_accepted || false} onChange={e => onChange({ ...value, terms_accepted: e.target.checked })} />I acknowledge the <a href="/account-notice" target="_blank" rel="noreferrer">account terms and privacy notice</a> (optional).</label>}
    </details>
  </>;
}
