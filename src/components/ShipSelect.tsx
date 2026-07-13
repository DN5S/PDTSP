import { ships } from '../data'

interface Props {
  value: number | null
  onChange: (id: number) => void
}

export function ShipSelect({ value, onChange }: Props) {
  return (
    <select
      className="ship-select"
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      <option value="" disabled>
        Select ship…
      </option>
      {ships.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} — {s.scu} SCU
        </option>
      ))}
    </select>
  )
}
