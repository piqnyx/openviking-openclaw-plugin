declare module 'tos-crc64-js' {
  export function crc64(buff: Buffer, prev?: string): string;
  export function combineCrc64(crc1: string, crc2: string, crc2BytesLen: number): string;
}
