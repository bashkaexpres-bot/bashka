export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MOTIVE_KEY = process.env.MOTIVE_API_KEY;
  const SB_URL = 'https://ghrbrwusfyjprxhivxfo.supabase.co';
  const SB_KEY = 'sb_publishable_NAFw4krk8evjh7Bx0VFD9g_EcuThMES';

  try {
    // Fetch vehicles from Motive
    const motiveRes = await fetch('https://api.gomotive.com/v1/vehicles?per_page=100', {
      headers: {
        'Authorization': `Bearer ${MOTIVE_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!motiveRes.ok) {
      const err = await motiveRes.text();
      return res.status(500).json({ error: 'Motive API error', details: err });
    }

    const motiveData = await motiveRes.json();
    const vehicles = motiveData.vehicles || [];

    const results = [];

    for (const v of vehicles) {
      const vehicleId = v.vehicle?.id?.toString();
      const odometer = v.vehicle?.current_meter_millimeters
        ? Math.round(v.vehicle.current_meter_millimeters / 1609344)
        : null;

      if (!vehicleId || !odometer) continue;

      // Sync to Supabase
      const syncRes = await fetch(`${SB_URL}/rest/v1/rpc/sync_motive_odometer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`
        },
        body: JSON.stringify({
          p_truck_id: vehicleId,
          p_motive_vehicle_id: vehicleId,
          p_odometer_miles: odometer
        })
      });

      results.push({
        vehicle_id: vehicleId,
        odometer_miles: odometer,
        synced: syncRes.ok
      });
    }

    return res.status(200).json({
      success: true,
      vehicles_found: vehicles.length,
      synced: results.length,
      results
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
