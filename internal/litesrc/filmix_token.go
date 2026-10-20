package litesrc

import (
	"context"
	stdjson "encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

type filmixTokenRights struct {
	premium bool
	expires time.Time
}

// A device token and an api-fx login can belong to different accounts. Check
// the effective token (including Kit overrides), never the api-fx session.
func (f *filmixChecker) tokenHasPremium(ctx context.Context, token string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}
	if value, ok := f.tokenRights.Load(token); ok {
		rights := value.(filmixTokenRights)
		if time.Now().Before(rights.expires) {
			return rights.premium
		}
	}

	body, ok := f.apiGet(ctx, "/api/v2/user_profile", f.makeAuthQuery(token), 64<<10)
	var profile struct {
		UserData *struct {
			Pro     filmixFlexBool `json:"is_pro"`
			ProPlus filmixFlexBool `json:"is_pro_plus"`
			ProDate string         `json:"pro_date"`
		} `json:"user_data"`
	}
	if ok && stdjson.Unmarshal([]byte(body), &profile) == nil && profile.UserData != nil {
		premium := bool(profile.UserData.Pro) || bool(profile.UserData.ProPlus)
		if until, err := time.Parse("2006-01-02", strings.TrimSpace(profile.UserData.ProDate)); err == nil && time.Now().After(until.Add(24*time.Hour)) {
			premium = false
		}
		f.tokenRights.Store(token, filmixTokenRights{premium, time.Now().Add(5 * time.Minute)})
		return premium
	}

	// A local pro=true flag is not proof of upstream rights. Retry a failed
	// profile check soon, without granting another account premium access.
	f.tokenRights.Store(token, filmixTokenRights{false, time.Now().Add(15 * time.Second)})
	return false
}

func (f *filmixChecker) cachedTokenPremium(token string) bool {
	value, ok := f.tokenRights.Load(strings.TrimSpace(token))
	if !ok {
		// The upstream background probe also verifies configured/reserve tokens.
		// Reuse its confirmed rights for the 429 re-mint path, which bypasses index.
		filmixTokenHealthMu.Lock()
		state, known := filmixTokenHealth[strings.TrimSpace(token)]
		filmixTokenHealthMu.Unlock()
		return known && state.Alive && state.Pro && time.Since(state.Checked) < filmixTokenProbeEvery &&
			(state.ProUntil.IsZero() || time.Now().Before(state.ProUntil.Add(24*time.Hour)))
	}
	rights := value.(filmixTokenRights)
	return rights.premium && time.Now().Before(rights.expires)
}

// Ignore service messages and empty playlists before choosing the token path,
// so a title unavailable to that API can still fall back to api-fx.
func (f *filmixChecker) tokenPostPlayable(post filmixPostRoot, token string) bool {
	if post.PlayerLinks == nil {
		return false
	}
	if len(post.PlayerLinks.Movie) > 0 {
		for _, movie := range post.PlayerLinks.Movie {
			if !filmixMovieBlocked(movie.Translation) && len(f.buildMovieStreams(movie, token, nil)) > 0 {
				return true
			}
		}
		return false
	}
	for _, voices := range post.PlayerLinks.Playlist {
		for _, raw := range voices {
			for _, episode := range filmixDecodeEpisodeSet(raw) {
				if len(f.buildEpisodeStreams(episode, token, nil)) > 0 {
					return true
				}
			}
		}
	}
	return false
}

func filmixMovieQualities(movie filmixMovie) []int {
	qualities := []int(movie.Qualities)
	if len(qualities) == 0 {
		if match := filmixQualityListRe.FindStringSubmatch(movie.Link); len(match) == 2 {
			for _, value := range strings.Split(match[1], ",") {
				if q, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
					qualities = append(qualities, q)
				}
			}
		}
	}
	return filmixSortedQualities(qualities)
}

func filmixSortedQualities(qualities []int) []int {
	seen := make(map[int]bool, len(qualities))
	out := make([]int, 0, len(qualities))
	for _, q := range qualities {
		if q > 0 && !seen[q] {
			seen[q] = true
			out = append(out, q)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(out)))
	return out
}

func filmixMovieBlocked(name string) bool {
	return strings.TrimSpace(name) != "" && filmixIsBlockedName(name)
}
