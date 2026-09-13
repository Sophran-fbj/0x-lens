/**
 * Pure display formatting. No float math on wei values.
 */

/** 6712354506914171645 wei → "6.7124" (4 significant decimals, zero-trimmed). */
export function formatEth(weiString: string): string {
  const full = formatEtherString(weiString);
  const [int = '0', dec = ''] = full.split('.');
  const trimmed = dec.slice(0, 4).replace(/0+$/, '');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 → "0xd8dA…6045" */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** wei (decimal string) → full ether string, integer part without leading zeros. */
function formatEtherString(wei: string): string {
  const padded = wei.padStart(19, '0'); // 10^18 has 19 digits
  const int = padded.slice(0, -18).replace(/^0+(?=\d)/, '');
  const dec = padded.slice(-18).replace(/0+$/, '');
  return dec ? `${int}.${dec}` : int;
}
