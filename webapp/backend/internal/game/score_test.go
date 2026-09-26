package game

import (
	"reflect"
	"testing"
)

func TestScore(t *testing.T) {
	// storyteller s, others a b c. Clips: S A B C.
	subs := map[string]string{"s": "S", "a": "A", "b": "B", "c": "C"}
	cases := []struct {
		name  string
		votes map[string]string
		want  map[string]int
	}{
		{
			name:  "everyone finds it: storyteller 0, others 2",
			votes: map[string]string{"a": "S", "b": "S", "c": "S"},
			want:  map[string]int{"s": 0, "a": 2, "b": 2, "c": 2},
		},
		{
			name:  "nobody finds it: storyteller 0, others 2 plus votes on own clip",
			votes: map[string]string{"a": "B", "b": "A", "c": "A"},
			want:  map[string]int{"s": 0, "a": 4, "b": 3, "c": 2},
		},
		{
			name:  "some find it: storyteller and finders 3, plus votes on own clip",
			votes: map[string]string{"a": "S", "b": "A", "c": "S"},
			want:  map[string]int{"s": 3, "a": 4, "b": 0, "c": 3},
		},
		{
			name:  "one finder, others fooled by one clip",
			votes: map[string]string{"a": "C", "b": "C", "c": "S"},
			want:  map[string]int{"s": 3, "a": 0, "b": 0, "c": 5},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Score("s", subs, tc.votes)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
