#include <stdbool.h>
#include <stdint.h>

/* Target of calls renamed by flangw.py. Keyword hashes for EXIST/OPENED fit in
   32 bits, so widening to the runtime's 64-bit InquiryKeywordHash is lossless. */
bool _FortranAioInquireLogical(void *cookie, uint64_t inquiry, bool *result);

bool hohq_InquireLogical32(void *cookie, uint32_t inquiry, bool *result) {
  return _FortranAioInquireLogical(cookie, inquiry, result);
}
